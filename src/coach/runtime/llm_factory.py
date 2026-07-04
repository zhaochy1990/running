"""LLM factories for the coach runtime — see plan §2.1, §7.5 and CLAUDE.md.

Three providers are supported:

* ``azure-openai`` — Azure OpenAI deployments (GPT-5.4, GPT-4.1, etc.) via
  ``langchain_openai.AzureChatOpenAI``.
* ``azure-ai-inference`` — Azure AI Foundry serverless endpoints (Claude,
  Gemini, Llama, etc.) via
  ``langchain_azure_ai.chat_models.AzureAIChatCompletionsModel``.
* ``openai-compatible`` — third-party OpenAI-compatible chat-completions
  endpoints (DeepSeek V4, etc.) via ``langchain_openai.ChatOpenAI``.

Three roles consume those providers:

* ``generator`` (coach agent)
* ``reviewer`` (critique agent)
* ``commentary`` (per-activity activity commentary — LIVE; consumed by
  ``stride_server.commentary_ai.generate_commentary``)

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
    if resolved_api_key is None and spec.auth_mode == "api-key" and spec.api_key_env:
        resolved_api_key = os.environ.get(spec.api_key_env)

    if spec.provider == "azure-openai":
        return _build_aoai(spec, spec.endpoint, credentials, resolved_api_key)
    if spec.provider == "azure-ai-inference":
        return _build_azure_ai_inference(spec, spec.endpoint, credentials, resolved_api_key)
    if spec.provider == "openai-compatible":
        return _build_openai_compatible(spec, spec.endpoint, resolved_api_key)
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


def build_orchestrator_llm(
    *,
    credentials: AzureCredentials | None = None,
    api_key: str | None = None,
    config: CoachConfig | None = None,
) -> Any:
    """Cheap/fast model for the orchestrator brain (§4.7).

    Powers Resolver / Supervisor / Aggregator / Memory Writer — small
    structured decisions, not deep reasoning. Falls back to the reviewer spec
    when no ``[orchestrator]`` section is configured (see ``CoachConfig``).
    """
    cfg = config or load_config()
    return build_chat_model(cfg.for_role("orchestrator"), credentials=credentials, api_key=api_key)


def build_commentary_llm(
    *,
    credentials: AzureCredentials | None = None,
    api_key: str | None = None,
    config: CoachConfig | None = None,
) -> Any:
    """Build the commentary-role LLM from ``cfg.commentary``.

    Consumed by ``coach_runtime.get_commentary_llm()`` (cached process-wide
    singleton), which ``commentary_ai.generate_commentary()`` calls from the
    post-sync hook and the ``/regenerate`` route.
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


def _build_openai_compatible(
    spec: ModelSpec,
    endpoint: str,
    api_key: str | None,
) -> Any:
    try:
        from langchain_openai import ChatOpenAI
    except ImportError as exc:
        raise CoachLLMUnavailable(
            "langchain-openai is required for openai-compatible provider. "
            'Install with `python -m pip install -e ".[web]"`.'
        ) from exc

    if not api_key:
        key_hint = spec.api_key_env or "the role's api_key_env"
        raise CoachLLMUnavailable(
            f"[{spec.role}] openai-compatible provider needs an API key; "
            f"set {key_hint} or pass api_key explicitly"
        )

    kwargs: dict[str, Any] = {
        "base_url": endpoint,
        "model": spec.deployment,
        "api_key": api_key,
        "timeout": spec.timeout_s,
    }
    if spec.temperature is not None:
        kwargs["temperature"] = spec.temperature
    if spec.max_tokens is not None:
        kwargs["max_tokens"] = spec.max_tokens
    if spec.reasoning_effort is not None:
        kwargs["reasoning_effort"] = spec.reasoning_effort
    kwargs.update(_openai_compatible_extra_kwargs(spec))
    return ChatOpenAI(**kwargs)


def _openai_compatible_extra_kwargs(spec: ModelSpec) -> dict[str, Any]:
    """Translate provider ``extra`` config into ``ChatOpenAI`` kwargs.

    DeepSeek-specific knobs stay in config, not graph code:
    ``extra.thinking`` becomes OpenAI SDK ``extra_body={"thinking": ...}``,
    and ``extra.response_format`` becomes ``model_kwargs`` so JSON Output can
    be enabled for roles/calls that truly need it.
    """
    extra = dict(spec.extra or {})
    kwargs: dict[str, Any] = {}

    model_kwargs = _pop_dict(extra, "model_kwargs")
    extra_body = _pop_dict(extra, "extra_body")

    if "thinking" in extra:
        extra_body["thinking"] = extra.pop("thinking")
    if "response_format" in extra:
        model_kwargs["response_format"] = extra.pop("response_format")

    direct_kwargs = {
        "default_headers",
        "default_query",
        "disabled_params",
        "frequency_penalty",
        "include",
        "logit_bias",
        "max_retries",
        "presence_penalty",
        "reasoning",
        "seed",
        "service_tier",
        "store",
        "stream_usage",
        "top_logprobs",
        "top_p",
        "truncation",
        "verbosity",
    }
    for key in sorted(direct_kwargs):
        if key in extra:
            kwargs[key] = extra.pop(key)

    # Remaining keys are treated as OpenAI request-body parameters. Prefer the
    # explicit ``model_kwargs`` bucket for new config, but this keeps provider
    # experiments from requiring code edits.
    model_kwargs.update(extra)
    if model_kwargs:
        kwargs["model_kwargs"] = model_kwargs
    if extra_body:
        kwargs["extra_body"] = extra_body
    return kwargs


def _pop_dict(raw: dict[str, Any], key: str) -> dict[str, Any]:
    value = raw.pop(key, None)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise CoachLLMUnavailable(
            f"ModelSpec.extra[{key!r}] must be a mapping, got {type(value).__name__}"
        )
    return dict(value)
