"""LLM factories for the coach runtime — see plan §2.1, §7.5 and CLAUDE.md.

Two providers are supported:

* ``azure-openai`` — Azure OpenAI deployments (GPT-5.4, GPT-4.1, etc.) via
  ``langchain_openai.AzureChatOpenAI``.
* ``azure-ai-inference`` — Azure AI Foundry serverless endpoints (Claude,
  Gemini, Llama, etc.) via
  ``langchain_azure_ai.chat_models.AzureAIChatCompletionsModel``.

Three roles consume those providers:

* ``generator`` (coach agent)
* ``reviewer`` (critique agent)
* ``commentary`` (per-activity commentary; **stub for now**, the prod
  commentary path is unchanged and will be migrated in a separate commit)

Role → ``ModelSpec`` mapping lives in ``config/coach.toml`` and is loaded by
``coach.runtime.config.load_config``. This module knows nothing about TOML;
it dispatches on ``spec.provider``.

azure-identity / azure SDKs are forbidden in ``coach.*`` by import-linter.
The adapter layer hands the factory an opaque ``AzureCredentials`` bundle
holding both a bearer-token callable (for ``langchain_openai``) and a
duck-typed ``TokenCredential`` (for ``langchain_azure_ai``); the factory
picks the right one per provider without ever touching ``azure.identity``.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .config import CoachConfig, load_config
from .model_spec import ModelSpec, Role


class CoachLLMUnavailable(RuntimeError):
    """Raised when an LLM cannot be constructed — typically missing env vars,
    a placeholder deployment id, or an uninstalled provider package."""


@dataclass(frozen=True)
class AzureCredentials:
    """Opaque credential bundle passed from the adapter layer to the factory.

    Two fields backed by the same underlying ``ChainedTokenCredential``:

    * ``bearer_token_provider`` — ``Callable[[], str]`` returning a current
      access token; consumed by ``langchain_openai.AzureChatOpenAI`` (which
      wants a callable token-provider for AAD auth).
    * ``token_credential`` — the raw ``azure.core.credentials.TokenCredential``
      instance; consumed by
      ``langchain_azure_ai.chat_models.AzureAIChatCompletionsModel`` (which
      wants a credential object, not a callable).

    The factory picks the field its provider needs. ``coach.*`` never imports
    azure-identity / azure.core — both fields are duck-typed ``Any``.
    """

    bearer_token_provider: Callable[[], str]
    token_credential: Any


# ---------------------------------------------------------------------------
# Core dispatch
# ---------------------------------------------------------------------------


def build_chat_model(
    spec: ModelSpec,
    *,
    credentials: AzureCredentials | None = None,
    api_key: str | None = None,
) -> Any:
    """Build a langchain ``BaseChatModel`` for ``spec``.

    For Managed Identity auth, the adapter layer passes ``credentials``. For
    api-key auth (dev / tests only), ``api_key`` is read from
    ``spec.api_key_env`` if not passed explicitly.
    """
    if spec.is_placeholder():
        raise CoachLLMUnavailable(
            f"[{spec.role}] deployment is still a placeholder ({spec.deployment!r}); "
            f"fill in config/coach.toml before invoking the {spec.role} model"
        )

    resolved_api_key = api_key
    if resolved_api_key is None and spec.api_key_env:
        resolved_api_key = os.environ.get(spec.api_key_env)

    if spec.provider == "azure-openai":
        return _build_aoai(spec, spec.endpoint, credentials, resolved_api_key)
    if spec.provider == "azure-ai-inference":
        return _build_azure_ai_inference(spec, spec.endpoint, credentials, resolved_api_key)
    raise CoachLLMUnavailable(f"unknown provider {spec.provider!r}")


# ---------------------------------------------------------------------------
# Role wrappers (read coach.toml, dispatch to build_chat_model)
# ---------------------------------------------------------------------------


def build_generator_llm(
    *,
    credentials: AzureCredentials | None = None,
    api_key: str | None = None,
    config: CoachConfig | None = None,
) -> Any:
    cfg = config or load_config()
    return build_chat_model(cfg.generator, credentials=credentials, api_key=api_key)


def build_reviewer_llm(
    *,
    credentials: AzureCredentials | None = None,
    api_key: str | None = None,
    config: CoachConfig | None = None,
) -> Any:
    cfg = config or load_config()
    return build_chat_model(cfg.reviewer, credentials=credentials, api_key=api_key)


def build_commentary_llm(
    *,
    credentials: AzureCredentials | None = None,
    api_key: str | None = None,
    config: CoachConfig | None = None,
) -> Any:
    """Forward-looking commentary factory.

    NOTE: nothing in the live route surface currently calls this — the
    production commentary path uses its own direct AOAI client. This stub
    exists so the migration commit (US-010 wire-up) has a target to call.
    """
    cfg = config or load_config()
    return build_chat_model(cfg.commentary, credentials=credentials, api_key=api_key)


# ---------------------------------------------------------------------------
# Provider builders
# ---------------------------------------------------------------------------


def _build_aoai(
    spec: ModelSpec,
    endpoint: str,
    credentials: AzureCredentials | None,
    api_key: str | None,
) -> Any:
    try:
        from langchain_openai import AzureChatOpenAI
    except ImportError as exc:
        raise CoachLLMUnavailable(
            "langchain-openai is required for azure-openai provider. "
            'Install with `python -m pip install -e ".[web]"`.'
        ) from exc

    kwargs: dict[str, Any] = {
        "azure_endpoint": endpoint,
        "azure_deployment": spec.deployment,
        "api_version": spec.api_version,
        "request_timeout": spec.timeout_s,
        # Route through /openai/responses when the deployment uses the
        # Responses API (some newer model families are only served there);
        # default stays on chat completions for back-compat.
        "use_responses_api": spec.api_kind == "responses",
    }
    if spec.temperature is not None:
        kwargs["temperature"] = spec.temperature
    if spec.max_tokens is not None:
        kwargs["max_tokens"] = spec.max_tokens
    if spec.reasoning_effort is not None:
        # Only meaningful for gpt-5 / o-series reasoning models on the
        # Responses API. langchain-openai accepts it as a direct kwarg;
        # non-reasoning models will surface a BadRequest at first
        # invocation rather than silently ignoring it.
        kwargs["reasoning_effort"] = spec.reasoning_effort

    if api_key:
        return AzureChatOpenAI(api_key=api_key, **kwargs)
    if credentials is None:
        raise CoachLLMUnavailable(
            f"[{spec.role}] azure-openai needs either api_key or credentials "
            "(adapter layer builds an AzureCredentials bundle via azure-identity)"
        )
    return AzureChatOpenAI(
        azure_ad_token_provider=credentials.bearer_token_provider, **kwargs
    )


def _build_azure_ai_inference(
    spec: ModelSpec,
    endpoint: str,
    credentials: AzureCredentials | None,
    api_key: str | None,
) -> Any:
    try:
        from langchain_azure_ai.chat_models import AzureAIChatCompletionsModel
    except ImportError as exc:
        raise CoachLLMUnavailable(
            "langchain-azure-ai is required for azure-ai-inference provider. "
            'Install with `python -m pip install -e ".[web]"`.'
        ) from exc

    kwargs: dict[str, Any] = {
        "endpoint": endpoint,
        "model_name": spec.deployment,
        "api_version": spec.api_version,
        "request_timeout": spec.timeout_s,
    }
    if spec.temperature is not None:
        kwargs["temperature"] = spec.temperature
    if spec.max_tokens is not None:
        kwargs["max_tokens"] = spec.max_tokens

    if api_key:
        return AzureAIChatCompletionsModel(credential=api_key, **kwargs)
    if credentials is None:
        raise CoachLLMUnavailable(
            f"[{spec.role}] azure-ai-inference needs either api_key or credentials "
            "(adapter layer builds an AzureCredentials bundle via azure-identity)"
        )
    return AzureAIChatCompletionsModel(
        credential=credentials.token_credential, **kwargs
    )
