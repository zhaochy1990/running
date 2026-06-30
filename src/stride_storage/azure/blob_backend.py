"""Shared Azure Blob container-client factory.

Mirrors ``azure/table_backend.py`` for Blob storage. The ``azure.*`` imports
are lazy (inside the function) so importing this module stays azure-free; the
credential is the shared :func:`get_credential`.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from stride_storage.azure.credentials import get_credential


@lru_cache(maxsize=4)
def get_container_client(account_url: str, container: str) -> Any:
    """Cached ``ContainerClient`` for ``(account_url, container)``."""
    from azure.storage.blob import BlobServiceClient

    service = BlobServiceClient(account_url=account_url, credential=get_credential())
    return service.get_container_client(container)


def reset_container_client_cache() -> None:
    """Test helper — drop cached container clients."""
    get_container_client.cache_clear()
