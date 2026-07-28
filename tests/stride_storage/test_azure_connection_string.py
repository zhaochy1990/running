"""Azure Storage clients honour STRIDE_AZURE_STORAGE_CONNECTION_STRING.

When the env var is set (local Azurite / shared-key), the Table/Queue/Blob
client factories build clients via ``from_connection_string`` instead of
``endpoint + DefaultAzureCredential`` — Azurite does not accept AAD tokens.
When unset, the default managed-identity path is unchanged (prod).

These construct clients only; no network call is made, so the tests are offline.
"""

from __future__ import annotations

import pytest

from stride_storage.azure import blob_backend, queue_backend, table_backend
from stride_storage.azure.connection import get_storage_connection_string

# Azurite well-known dev account + explicit endpoints.
AZURITE_CS = (
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;"
    "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/"
    "K1SZFPTOtr/KBHBeksoGMGw==;"
    "BlobEndpoint=http://azurite:10000/devstoreaccount1;"
    "QueueEndpoint=http://azurite:10001/devstoreaccount1;"
    "TableEndpoint=http://azurite:10002/devstoreaccount1;"
)

PROD_TABLE_URL = "https://prodacct.table.core.windows.net/"
PROD_BLOB_URL = "https://prodacct.blob.core.windows.net/"
PROD_QUEUE_URL = "https://prodacct.queue.core.windows.net/"


@pytest.fixture(autouse=True)
def _clear_caches():
    blob_backend.reset_container_client_cache()
    queue_backend.reset_queue_client_cache()
    yield
    blob_backend.reset_container_client_cache()
    queue_backend.reset_queue_client_cache()


def test_get_connection_string_reads_env(monkeypatch):
    monkeypatch.delenv("STRIDE_AZURE_STORAGE_CONNECTION_STRING", raising=False)
    assert get_storage_connection_string() is None

    monkeypatch.setenv("STRIDE_AZURE_STORAGE_CONNECTION_STRING", AZURITE_CS)
    assert get_storage_connection_string() == AZURITE_CS

    # Whitespace-only is treated as unset.
    monkeypatch.setenv("STRIDE_AZURE_STORAGE_CONNECTION_STRING", "   ")
    assert get_storage_connection_string() is None


def test_table_uses_connection_string_when_set(monkeypatch):
    monkeypatch.setenv("STRIDE_AZURE_STORAGE_CONNECTION_STRING", AZURITE_CS)
    svc = table_backend._build_table_service(PROD_TABLE_URL)
    assert svc.account_name == "devstoreaccount1"
    assert "10002/devstoreaccount1" in svc.url


def test_table_uses_account_url_when_unset(monkeypatch):
    monkeypatch.delenv("STRIDE_AZURE_STORAGE_CONNECTION_STRING", raising=False)
    svc = table_backend._build_table_service(PROD_TABLE_URL)
    assert "prodacct.table.core.windows.net" in svc.url


def test_blob_uses_connection_string_when_set(monkeypatch):
    monkeypatch.setenv("STRIDE_AZURE_STORAGE_CONNECTION_STRING", AZURITE_CS)
    client = blob_backend.get_container_client(PROD_BLOB_URL, "content")
    assert client.account_name == "devstoreaccount1"
    assert "10000/devstoreaccount1" in client.url


def test_blob_uses_account_url_when_unset(monkeypatch):
    monkeypatch.delenv("STRIDE_AZURE_STORAGE_CONNECTION_STRING", raising=False)
    client = blob_backend.get_container_client(PROD_BLOB_URL, "content")
    assert "prodacct.blob.core.windows.net" in client.url


def test_queue_uses_connection_string_when_set(monkeypatch):
    monkeypatch.setenv("STRIDE_AZURE_STORAGE_CONNECTION_STRING", AZURITE_CS)
    client = queue_backend._build_queue_client(PROD_QUEUE_URL, "stridejobs")
    assert client.account_name == "devstoreaccount1"
    assert client.queue_name == "stridejobs"
    assert "10001/devstoreaccount1" in client.url


def test_queue_uses_account_url_when_unset(monkeypatch):
    monkeypatch.delenv("STRIDE_AZURE_STORAGE_CONNECTION_STRING", raising=False)
    client = queue_backend._build_queue_client(PROD_QUEUE_URL, "stridejobs")
    assert "prodacct.queue.core.windows.net" in client.url
    assert client.queue_name == "stridejobs"
