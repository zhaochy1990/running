"""LLM client wrapper — Azure OpenAI (same auth pattern as aoai_client.py).

Rationale for Azure OpenAI over Anthropic SDK:
  The project already uses Azure OpenAI (GPT-4.1) via ``aoai_client.py`` with
  both API-key and Managed Identity auth. Introducing a second provider
  (Anthropic SDK) would require a new secret, new dep, and diverge from the
  existing auth pattern. T01 therefore wraps AzureOpenAI under the same env-var
  conventions, but exposes a provider-neutral interface so a future swap to
  Anthropic or another backend only requires changing this file.

Environment variables (all optional — client raises LLMUnavailable if absent):
  AZURE_OPENAI_ENDPOINT      — required
  AZURE_OPENAI_API_KEY       — if set, used directly; otherwise DefaultAzureCredential
  AZURE_OPENAI_API_VERSION   — default "2024-10-21"
  LLM_DEFAULT_MODEL          — deployment name; default "gpt-4.1"
  LLM_ENABLED                — must be "true" (case-insensitive) for the client
                                to initialise; useful to gate in prod without
                                removing env vars. Defaults to "true" when
                                AZURE_OPENAI_ENDPOINT is set, so existing
                                deployments need no extra config.
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class LLMUnavailable(Exception):
    """Raised at construction time when credentials / config are missing."""


class LLMError(Exception):
    """Raised when an LLM call fails.

    ``retryable=True``  — transient (network, rate-limit); caller may retry.
    ``retryable=False`` — permanent (auth, bad request, context too long).
    """

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _is_enabled() -> bool:
    """Feature gate. Default ON when AZURE_OPENAI_ENDPOINT is set."""
    val = os.environ.get("LLM_ENABLED", "").strip().lower()
    if val:
        return val == "true"
    # Implicit: enabled iff the endpoint is configured.
    return bool(os.environ.get("AZURE_OPENAI_ENDPOINT", "").strip())


def _default_model() -> str:
    return os.environ.get("LLM_DEFAULT_MODEL", "gpt-4.1")


def _build_aoai_client() -> Any:
    """Build and return an AzureOpenAI client; raise LLMUnavailable on failure."""
    try:
        from openai import AzureOpenAI
    except ImportError as exc:
        raise LLMUnavailable(f"openai SDK not installed: {exc}") from exc

    endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT", "").strip()
    if not endpoint:
        raise LLMUnavailable("AZURE_OPENAI_ENDPOINT is not set")

    api_version = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-10-21")
    api_key = os.environ.get("AZURE_OPENAI_API_KEY", "").strip()

    if api_key:
        client = AzureOpenAI(
            azure_endpoint=endpoint,
            api_version=api_version,
            api_key=api_key,
        )
        logger.info("LLMClient: AzureOpenAI via API key (endpoint=%s)", endpoint)
        return client

    # Fallback: DefaultAzureCredential (MI in prod, az login locally)
    try:
        from azure.identity import DefaultAzureCredential, get_bearer_token_provider
    except ImportError as exc:
        raise LLMUnavailable(
            "AZURE_OPENAI_API_KEY not set and azure-identity not installed; "
            f"install azure-identity or set AZURE_OPENAI_API_KEY. ({exc})"
        ) from exc

    credential = DefaultAzureCredential()
    token_provider = get_bearer_token_provider(
        credential, "https://cognitiveservices.azure.com/.default"
    )
    client = AzureOpenAI(
        azure_endpoint=endpoint,
        api_version=api_version,
        azure_ad_token_provider=token_provider,
    )
    logger.info("LLMClient: AzureOpenAI via Managed Identity (endpoint=%s)", endpoint)
    return client


# ---------------------------------------------------------------------------
# Public client
# ---------------------------------------------------------------------------


class LLMClient:
    """Thin provider-neutral wrapper around AzureOpenAI.

    Raises ``LLMUnavailable`` at construction time when env vars are absent or
    the SDK is not installed.  Callers should catch this and return HTTP 503.

    Thread-safety: ``chat_sync`` is thread-safe (each call is independent).
    ``chat_async_job`` spawns a daemon thread; the callback is invoked once.
    """

    def __init__(self) -> None:
        if not _is_enabled():
            raise LLMUnavailable(
                "LLM is not enabled. Set AZURE_OPENAI_ENDPOINT (and optionally "
                "LLM_ENABLED=true)."
            )
        # May raise LLMUnavailable.
        self._client: Any = _build_aoai_client()
        self._default_model: str = _default_model()

    # ------------------------------------------------------------------
    # Synchronous call
    # ------------------------------------------------------------------

    def chat_sync(
        self,
        system: str,
        messages: list[dict],
        model: str | None = None,
        max_tokens: int = 2048,
    ) -> str:
        """Make a blocking chat-completion call.

        ``messages`` follows the OpenAI messages format (list of dicts with
        ``role`` and ``content``).  A ``{"role": "system", "content": system}``
        entry is prepended automatically.

        Returns the assistant's text content.

        Raises:
            LLMError(retryable=True)  — rate limit, connection error, timeout.
            LLMError(retryable=False) — auth failure, context too long, etc.
        """
        deployment = model or self._default_model
        full_messages = [{"role": "system", "content": system}, *messages]
        try:
            response = self._client.chat.completions.create(
                model=deployment,
                messages=full_messages,
                max_tokens=max_tokens,
                temperature=0.7,
                timeout=60,
            )
            return (response.choices[0].message.content or "").strip()
        except Exception as exc:
            raise _map_exception(exc) from exc

    # ------------------------------------------------------------------
    # Async (fire-and-forget) job
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
        """Spawn a daemon thread; call ``callback(result, None)`` on success or
        ``callback(None, exc)`` on failure.  Returns immediately.
        """

        def _run() -> None:
            try:
                result = self.chat_sync(system, messages, model=model, max_tokens=max_tokens)
                logger.debug("LLMClient async job %s completed", job_id)
                callback(result, None)
            except Exception as exc:
                logger.warning("LLMClient async job %s failed: %s", job_id, exc)
                callback(None, exc)

        t = threading.Thread(target=_run, daemon=True, name=f"llm-job-{job_id}")
        t.start()


# ---------------------------------------------------------------------------
# Exception mapping
# ---------------------------------------------------------------------------


def _map_exception(exc: Exception) -> LLMError:
    """Translate SDK / network exceptions into ``LLMError``."""
    exc_type = type(exc).__name__
    exc_module = type(exc).__module__ or ""

    # openai SDK exceptions live under openai.*
    if "openai" in exc_module or exc_type in {
        "APIConnectionError", "APITimeoutError",
        "RateLimitError", "InternalServerError",
    }:
        retryable = exc_type in {
            "APIConnectionError", "APITimeoutError",
            "RateLimitError", "InternalServerError",
        }
        return LLMError(str(exc), retryable=retryable)

    # Generic network errors
    if exc_type in {"ConnectError", "ReadTimeout", "TimeoutException"}:
        return LLMError(str(exc), retryable=True)

    # Auth / quota / bad-request — non-retryable
    if exc_type in {"AuthenticationError", "PermissionDeniedError", "BadRequestError"}:
        return LLMError(str(exc), retryable=False)

    # Unknown — treat as non-retryable to avoid accidental loops
    return LLMError(f"{exc_type}: {exc}", retryable=False)
