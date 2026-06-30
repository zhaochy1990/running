"""Shared Azure Key Vault ``SecretClient`` factory.

Cached per vault URL; uses the shared :func:`get_credential`. The
``azure.keyvault`` import is lazy so importing this module stays azure-free.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from stride_storage.azure.credentials import get_credential


@lru_cache(maxsize=8)
def get_secret_client(vault_url: str) -> Any:
    """Cached ``SecretClient`` for ``vault_url``."""
    from azure.keyvault.secrets import SecretClient

    return SecretClient(vault_url=vault_url, credential=get_credential())


def is_secret_not_found(exc: Exception) -> bool:
    """True if ``exc`` is Azure's ``ResourceNotFoundError`` (by class name, so
    callers don't need to import the SDK to branch on it)."""
    return exc.__class__.__name__ == "ResourceNotFoundError"


def reset_secret_client_cache() -> None:
    """Test helper — drop cached secret clients."""
    get_secret_client.cache_clear()
