"""Azure OpenAI client — singleton, env-gated, authenticated via DefaultAzureCredential.

Gate: AOAI_COMMENTARY_ENABLED must be 'true' for any call to succeed.
Auth: DefaultAzureCredential picks up Container App's Managed Identity in prod and
`az login` locally. No API keys.
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
            from azure.identity import DefaultAzureCredential, get_bearer_token_provider
        except ImportError as e:
            raise AOAIUnavailable(
                f"Azure OpenAI deps not installed (need openai + azure-identity): {e}"
            )
        endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT")
        if not endpoint:
            raise AOAIUnavailable("AZURE_OPENAI_ENDPOINT not set")
        api_version = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-10-21")
        credential = DefaultAzureCredential()
        token_provider = get_bearer_token_provider(
            credential, "https://cognitiveservices.azure.com/.default"
        )
        _client = AzureOpenAI(
            azure_endpoint=endpoint,
            api_version=api_version,
            azure_ad_token_provider=token_provider,
        )
        logger.info("AOAI client initialised (endpoint=%s, deployment=%s)",
                    endpoint, get_deployment())
        return _client
