"""Backward-compatible Azure OpenAI client helpers.

The live commentary path now goes through ``commentary_ai`` / coach runtime,
but older tests and a few imports still expect this small module surface.
"""

from __future__ import annotations

from typing import Any

from .config import load_server_config
from .config.models import AzureOpenAIConfig, CommentaryConfig

_client: Any | None = None
_client_key: tuple[str, str, str, str, float] | None = None


def is_enabled_from_config(config: CommentaryConfig) -> bool:
    return bool(config.enabled)


def get_deployment_from_config(config: CommentaryConfig) -> str:
    return config.azure_openai.deployment


def _effective_config(config: CommentaryConfig | None = None) -> AzureOpenAIConfig:
    if config is not None:
        return config.azure_openai
    return load_server_config().commentary.azure_openai


def _cache_key(config: AzureOpenAIConfig) -> tuple[str, str, str, str, float]:
    return (
        config.endpoint,
        config.api_key,
        config.api_version,
        config.deployment,
        config.timeout_s,
    )


def get_client(*, config: CommentaryConfig | None = None) -> Any:
    global _client, _client_key

    effective = _effective_config(config)
    key = _cache_key(effective)
    if _client is not None and _client_key == key:
        return _client

    try:
        import openai
    except ImportError as exc:  # pragma: no cover - dependency-gated
        raise RuntimeError("openai package is not installed") from exc

    kwargs: dict[str, Any] = {
        "azure_endpoint": effective.endpoint,
        "api_version": effective.api_version,
        "timeout": effective.timeout_s,
    }
    if effective.api_key:
        kwargs["api_key"] = effective.api_key
    _client = openai.AzureOpenAI(**kwargs)
    _client_key = key
    return _client
