"""LLM client — coach.runtime / langchain-backed.

Historically this module wrapped ``openai.AzureOpenAI`` directly. After the
LLM-consolidation refactor it is a thin shim over
:func:`coach.runtime.coach_runtime.get_generator_llm`, which reads
``config/coach.toml`` and returns a langchain ``BaseChatModel``. Public
surface (``LLMClient`` / ``LLMUnavailable`` / ``LLMError``) is preserved so
existing routes and tests don't need to change.

Why the indirection: routes plus the master-plan adapter call
``LLMClient().chat_sync(system, messages, max_tokens=...)``. Tests
monkeypatch ``LLMClient`` on a route module. Reusing this class shape
lets the production stack consolidate to coach.toml without rewriting
those call sites.

Single source of truth:
* Endpoint / deployment / api_version / api_kind → ``config/coach.toml``
  ``[generator]`` (or ``[reviewer]`` / ``[commentary]`` via the other
  factory functions if a future caller needs them).
* Auth → ``coach_runtime._build_azure_credentials`` (chained
  ``AzureCliCredential`` → ``DefaultAzureCredential``).

The env vars ``AZURE_OPENAI_ENDPOINT`` / ``AZURE_OPENAI_API_KEY`` /
``AZURE_OPENAI_API_VERSION`` / ``LLM_DEFAULT_MODEL`` / ``LLM_ENABLED`` are
no longer read here — they're left in place for ``aoai_client`` /
``commentary_ai`` callers that haven't migrated yet (see
``commentary_ai.is_enabled`` for the surviving feature gate).
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

from coach.runtime.llm_factory import CoachLLMUnavailable
from coach.runtime.messages import extract_text

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Exceptions — kept name-compatible with the pre-refactor surface.
# ---------------------------------------------------------------------------


class LLMUnavailable(CoachLLMUnavailable):
    """Raised when the LLM cannot be constructed (missing config, placeholder
    deployment, SDK not installed).

    Subclasses :class:`CoachLLMUnavailable` so legacy ``except LLMUnavailable``
    handlers and new ``except CoachLLMUnavailable`` handlers both work.
    """


class LLMError(Exception):
    """Raised when an LLM call fails at runtime.

    ``retryable=True``  — transient (network, rate-limit); caller may retry.
    ``retryable=False`` — permanent (auth, bad request, context too long).
    """

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


# Exception classifiers — names match what langchain / openai SDK raise.
_RETRYABLE_EXC_NAMES = frozenset(
    {
        "APIConnectionError",
        "APITimeoutError",
        "RateLimitError",
        "InternalServerError",
        "ServiceUnavailableError",
        "ConnectError",
        "ReadTimeout",
        "TimeoutException",
    }
)
_PERMANENT_EXC_NAMES = frozenset(
    {
        "AuthenticationError",
        "PermissionDeniedError",
        "BadRequestError",
        "NotFoundError",
        "UnprocessableEntityError",
        "InvalidRequestError",
    }
)


def _map_exception(exc: BaseException) -> LLMError:
    """Translate a langchain / openai SDK exception into an :class:`LLMError`.

    Unknown exception types default to non-retryable so we don't accidentally
    loop on something we can't categorise.
    """
    name = type(exc).__name__
    if name in _RETRYABLE_EXC_NAMES:
        return LLMError(str(exc), retryable=True)
    if name in _PERMANENT_EXC_NAMES:
        return LLMError(str(exc), retryable=False)
    return LLMError(f"{name}: {exc}", retryable=False)


# ---------------------------------------------------------------------------
# Public client — same API as the pre-refactor version.
# ---------------------------------------------------------------------------


class LLMClient:
    """Thin shim over :func:`coach_runtime.get_generator_llm`.

    Construction may raise :class:`LLMUnavailable` if ``config/coach.toml``
    points at a placeholder deployment or the langchain provider package
    isn't installed. Routes that wrap ``LLMClient()`` in a try/except for
    ``LLMUnavailable`` get the same behaviour as before.

    ``chat_sync`` accepts the historical OpenAI ``messages`` dict shape so
    callers don't need to change. Under the hood the messages are converted
    to langchain ``BaseMessage`` instances and the response's ``.content``
    string is returned (Responses API ``list[dict]`` content is flattened
    via :func:`coach.runtime.messages.extract_text`).
    """

    def __init__(self) -> None:
        from .coach_runtime import get_generator_llm

        try:
            self._llm: Any = get_generator_llm()
        except CoachLLMUnavailable as exc:
            # Re-wrap so callers that catch our subclass keep working.
            raise LLMUnavailable(str(exc)) from exc

    # ------------------------------------------------------------------
    # Synchronous call
    # ------------------------------------------------------------------

    def chat_sync(
        self,
        system: str,
        messages: list[dict],
        model: str | None = None,
        max_tokens: int | None = None,
        reasoning_effort: str | None = None,
    ) -> str:
        """Make a blocking chat call.

        ``messages`` follows the OpenAI dict shape. A ``SystemMessage`` with
        ``system`` is prepended automatically.

        ``model`` is ignored — the langchain client is bound to the
        ``[generator]`` deployment from ``config/coach.toml`` at construction
        time. Signature kept for back-compat with legacy callers.

        ``max_tokens`` IS honoured when set as a per-call override. When
        ``None`` (default), the bound deployment's construction-time
        ``max_tokens`` from ``[generator]`` config applies — that's the
        path callers should usually take, so the budget is tunable from
        ``config/coach.toml`` without code edits. LangChain OpenAI models
        normalize that constructor value to ``max_completion_tokens`` before
        producing either Chat Completions or Responses payloads, so per-call
        overrides must use the same internal kwarg. Binding ``max_tokens`` or
        ``max_output_tokens`` can leave the constructor default in place and
        add a second, conflicting request parameter.

        ``reasoning_effort`` (``"minimal"`` / ``"low"`` / ``"medium"`` /
        ``"high"``) caps reasoning-token consumption on gpt-5 / o-series
        models. Lowering it trades depth for output-token budget; only
        flip from the model default when you have evidence the output is
        consistently truncating. Non-reasoning models reject the kwarg
        (surfaces as ``LLMError(retryable=False)``).

        Returns the assistant's text content, stripped.

        Raises :class:`LLMError` (with ``retryable`` set) on any SDK-side
        failure.
        """
        del model  # coach.toml-driven; signature kept for compat

        lc_messages: list[BaseMessage] = [SystemMessage(content=system)]
        for raw in messages or []:
            role = (raw.get("role") or "user").lower()
            content = raw.get("content", "")
            if role == "system":
                lc_messages.append(SystemMessage(content=content))
            elif role == "assistant":
                lc_messages.append(AIMessage(content=content))
            else:
                lc_messages.append(HumanMessage(content=content))

        # Bind per-call kwargs when provided. langchain's BaseChatModel.bind
        # returns a Runnable wrapping the model with extra kwargs passed to
        # invoke. If the underlying provider rejects a kwarg (e.g. a
        # non-reasoning model rejecting reasoning_effort), the BadRequestError
        # surfaces as LLMError(retryable=False) via _map_exception — that's
        # preferable to silently dropping the caller's intent.
        bind_kwargs: dict[str, Any] = {}
        if max_tokens is not None:
            # langchain-openai stores constructor ``max_tokens`` as the
            # provider-neutral ``max_completion_tokens`` default. Bind the
            # same key so per-call overrides replace that default instead of
            # creating an invalid ``max_tokens`` + ``max_completion_tokens``
            # pair in the final OpenAI/Azure request body.
            bind_kwargs["max_completion_tokens"] = max_tokens
        if reasoning_effort is not None:
            bind_kwargs["reasoning_effort"] = reasoning_effort
        target = self._llm.bind(**bind_kwargs) if bind_kwargs else self._llm

        try:
            resp = target.invoke(lc_messages)
        except CoachLLMUnavailable as exc:
            raise LLMUnavailable(str(exc)) from exc
        except BaseException as exc:
            raise _map_exception(exc) from exc

        return extract_text(getattr(resp, "content", resp)).strip()

    # ------------------------------------------------------------------
    # Async (fire-and-forget) job — legacy surface, kept for back-compat.
    # ------------------------------------------------------------------

    def chat_async_job(
        self,
        job_id: str,
        system: str,
        messages: list[dict],
        callback: Callable[[str | None, Exception | None], None],
        model: str | None = None,
        max_tokens: int = 2048,
    ) -> None:
        """Spawn a daemon thread; call ``callback`` once with (result, None) or
        (None, exc).

        Kept for API compatibility; no production code currently calls this
        path (grep confirms zero callers). Safe to delete in a follow-up once
        this is verified across forks / branches.
        """

        def _run() -> None:
            try:
                result = self.chat_sync(
                    system, messages, model=model, max_tokens=max_tokens
                )
                callback(result, None)
            except Exception as exc:  # noqa: BLE001 — boundary
                logger.warning("LLMClient async job %s failed: %s", job_id, exc)
                callback(None, exc)

        threading.Thread(target=_run, daemon=True, name=f"llm-job-{job_id}").start()
