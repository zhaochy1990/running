"""Tier C-adjacent — Azure Key Vault secret access.

A single shared ``SecretClient`` factory (using the shared
:func:`stride_storage.azure.credentials.get_credential`) replaces the three
independent Key Vault clients that the server config loader, COROS auth, and
Garmin auth each constructed. ``azure.*`` imports are lazy.
"""

from stride_storage.keyvault.secret_client import (
    get_secret_client,
    is_secret_not_found,
    reset_secret_client_cache,
)

__all__ = [
    "get_secret_client",
    "is_secret_not_found",
    "reset_secret_client_cache",
]
