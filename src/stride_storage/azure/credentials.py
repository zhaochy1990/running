"""Shared ``DefaultAzureCredential`` factory — one credential per process.

Replaces the 8 independent ``DefaultAzureCredential()`` instantiations that
were scattered across the per-store modules. The ``azure.identity`` import is
lazy (inside the function) so importing this module does not pull the Azure
SDK; the credential is only constructed the first time a real Azure backend
needs it.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any


@lru_cache(maxsize=1)
def get_credential() -> Any:
    """Process-wide cached ``DefaultAzureCredential``.

    Managed identity in prod (ACA), developer credential locally. Heavy to
    construct, so cached; safe to share across Table/Blob/Key Vault clients.
    """
    from azure.identity import DefaultAzureCredential

    return DefaultAzureCredential()


def reset_credential_cache() -> None:
    """Test helper — drop the cached credential."""
    get_credential.cache_clear()
