"""Azure OpenAI client — singleton, env-gated.

Gate: AOAI_COMMENTARY_ENABLED must be 'true' for any call to succeed.

Auth (tried in order):
  1. API key — if AZURE_OPENAI_API_KEY is set, use it directly
  2. Managed Identity / `az login` — DefaultAzureCredential fallback
     (requires `Cognitive Services OpenAI User` RBAC on the AOAI resource)

Key-based auth is simpler to set up; MI is preferred for production once RBAC
is configured. Both produce the same AzureOpenAI client.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from stride_server.config import load_server_config
from stride_server.config.models import CommentaryConfig

logger = logging.getLogger(__name__)


class AOAIUnavailable(RuntimeError):
    """Raised when AOAI isn't configured or the feature flag is off."""


_client: Any | None = None
_client_cache_key: tuple[str, str, str, str, float] | None = None
_client_lock = threading.Lock()


def is_enabled_from_config(config: CommentaryConfig) -> bool:
    return config.enabled


def get_deployment_from_config(config: CommentaryConfig) -> str:
    return config.azure_openai.deployment


def _commentary_config() -> CommentaryConfig:
    return load_server_config().commentary


def _client_key(config: CommentaryConfig) -> tuple[str, str, str, str, float]:
    azure = config.azure_openai
    return (
        azure.endpoint.strip(),
        azure.api_version,
        azure.api_key.strip(),
        azure.deployment,
        azure.timeout_s,
    )


def is_enabled() -> bool:
    return is_enabled_from_config(_commentary_config())


def get_deployment() -> str:
    return get_deployment_from_config(_commentary_config())


def get_client(config: CommentaryConfig | None = None):
    """Return a cached AzureOpenAI client, or raise AOAIUnavailable."""
    global _client, _client_cache_key
    cfg = config or _commentary_config()
    if not is_enabled_from_config(cfg):
        raise AOAIUnavailable("AOAI_COMMENTARY_ENABLED is not 'true'")
    cache_key = _client_key(cfg)
    if _client is not None and _client_cache_key == cache_key:
        return _client
    with _client_lock:
        if _client is not None and _client_cache_key == cache_key:
            return _client
        try:
            from openai import AzureOpenAI
        except ImportError as e:
            raise AOAIUnavailable(f"openai SDK not installed: {e}")

        endpoint = cfg.azure_openai.endpoint.strip()
        if not endpoint:
            raise AOAIUnavailable("commentary.azure_openai.endpoint not configured")
        api_version = cfg.azure_openai.api_version
        api_key = cfg.azure_openai.api_key.strip()
        timeout_s = cfg.azure_openai.timeout_s
        deployment = get_deployment_from_config(cfg)

        if api_key:
            _client = AzureOpenAI(
                azure_endpoint=endpoint,
                api_version=api_version,
                api_key=api_key,
                timeout=timeout_s,
            )
            _client_cache_key = cache_key
            logger.info("AOAI client initialised via API key (endpoint=%s, deployment=%s)",
                        endpoint, deployment)
            return _client

        # Fallback: DefaultAzureCredential (MI in prod, az login locally)
        try:
            from azure.identity import DefaultAzureCredential, get_bearer_token_provider
        except ImportError as e:
            raise AOAIUnavailable(
                "AZURE_OPENAI_API_KEY not set and azure-identity not installed: "
                f"{e}. Either set AZURE_OPENAI_API_KEY or install azure-identity."
            )
        credential = DefaultAzureCredential()
        token_provider = get_bearer_token_provider(
            credential, "https://cognitiveservices.azure.com/.default"
        )
        _client = AzureOpenAI(
            azure_endpoint=endpoint,
            api_version=api_version,
            azure_ad_token_provider=token_provider,
            timeout=timeout_s,
        )
        _client_cache_key = cache_key
        logger.info("AOAI client initialised via Managed Identity (endpoint=%s, deployment=%s)",
                    endpoint, deployment)
        return _client
