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
import os
import threading
from typing import Any

logger = logging.getLogger(__name__)


class AOAIUnavailable(RuntimeError):
    """Raised when AOAI isn't configured or the feature flag is off."""


_client: Any | None = None
_client_lock = threading.Lock()


def is_enabled() -> bool:
    return os.environ.get("AOAI_COMMENTARY_ENABLED", "").lower() == "true"


def get_deployment() -> str:
    return os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-4.1")


def get_client():
    """Return a cached AzureOpenAI client, or raise AOAIUnavailable."""
    global _client
    if not is_enabled():
        raise AOAIUnavailable("AOAI_COMMENTARY_ENABLED is not 'true'")
    if _client is not None:
        return _client
    with _client_lock:
        if _client is not None:
            return _client
        try:
            from openai import AzureOpenAI
        except ImportError as e:
            raise AOAIUnavailable(f"openai SDK not installed: {e}")

        endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT")
        if not endpoint:
            raise AOAIUnavailable("AZURE_OPENAI_ENDPOINT not set")
        api_version = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-10-21")
        api_key = os.environ.get("AZURE_OPENAI_API_KEY")

        if api_key:
            _client = AzureOpenAI(
                azure_endpoint=endpoint,
                api_version=api_version,
                api_key=api_key,
            )
            logger.info("AOAI client initialised via API key (endpoint=%s, deployment=%s)",
                        endpoint, get_deployment())
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
        )
        logger.info("AOAI client initialised via Managed Identity (endpoint=%s, deployment=%s)",
                    endpoint, get_deployment())
        return _client
