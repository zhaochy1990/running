from __future__ import annotations

import pytest

from stride_server import content_store


class ResourceNotFoundError(Exception):
    pass


class FakeDownloader:
    def __init__(self, value: bytes) -> None:
        self._value = value

    def readall(self) -> bytes:
        return self._value


class FakeBlobClient:
    def __init__(self, exists: bool) -> None:
        self._exists = exists

    def exists(self) -> bool:
        return self._exists


class FakeContainerClient:
    def __init__(self, blobs: dict[str, bytes]) -> None:
        self.blobs = blobs

    def download_blob(self, name: str) -> FakeDownloader:
        if name not in self.blobs:
            raise ResourceNotFoundError(name)
        return FakeDownloader(self.blobs[name])

    def get_blob_client(self, name: str) -> FakeBlobClient:
        return FakeBlobClient(name in self.blobs)

    def list_blobs(self, name_starts_with: str):
        for name in self.blobs:
            if name.startswith(name_starts_with):
                yield type("Blob", (), {"name": name})()


@pytest.fixture(autouse=True)
def clear_blob_env(monkeypatch):
    for key in (
        content_store.ACCOUNT_URL_ENV,
        content_store.CONTAINER_ENV,
        content_store.PREFIX_ENV,
    ):
        monkeypatch.delenv(key, raising=False)
    content_store._container_client.cache_clear()


def test_read_text_uses_filesystem_by_default(tmp_path, monkeypatch):
    from stride_core import db as core_db

    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    path = tmp_path / "user-1" / "TRAINING_PLAN.md"
    path.parent.mkdir(parents=True)
    path.write_text("# Plan", encoding="utf-8")

    item = content_store.read_text("user-1/TRAINING_PLAN.md")

    assert item is not None
    assert item.source == "file"
    assert item.content == "# Plan"


def test_read_text_prefers_blob_when_configured(monkeypatch):
    fake = FakeContainerClient({"users/user-1/TRAINING_PLAN.md": "# Blob Plan".encode()})
    monkeypatch.setenv(content_store.ACCOUNT_URL_ENV, "https://acct.blob.core.windows.net/")
    monkeypatch.setenv(content_store.CONTAINER_ENV, "stride-data")
    monkeypatch.setattr(content_store, "_container_client", lambda _account, _container: fake)

    item = content_store.read_text("user-1/TRAINING_PLAN.md")

    assert item is not None
    assert item.source == "blob"
    assert item.content == "# Blob Plan"


def test_blob_miss_falls_back_to_filesystem(tmp_path, monkeypatch):
    from stride_core import db as core_db

    fake = FakeContainerClient({})
    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    monkeypatch.setenv(content_store.ACCOUNT_URL_ENV, "https://acct.blob.core.windows.net/")
    monkeypatch.setenv(content_store.CONTAINER_ENV, "stride-data")
    monkeypatch.setattr(content_store, "_container_client", lambda _account, _container: fake)
    path = tmp_path / "user-1" / "logs" / "2026-04-20_04-26(W0)" / "plan.md"
    path.parent.mkdir(parents=True)
    path.write_text("from file", encoding="utf-8")

    item = content_store.read_text("user-1/logs/2026-04-20_04-26(W0)/plan.md")

    assert item is not None
    assert item.source == "file"
    assert item.content == "from file"


def test_list_week_folders_merges_blob_and_filesystem(tmp_path, monkeypatch):
    from stride_core import db as core_db

    fake = FakeContainerClient({
        "users/user-1/logs/2026-04-20_04-26(W0)/plan.md": b"blob",
    })
    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    monkeypatch.setenv(content_store.ACCOUNT_URL_ENV, "https://acct.blob.core.windows.net/")
    monkeypatch.setenv(content_store.CONTAINER_ENV, "stride-data")
    monkeypatch.setattr(content_store, "_container_client", lambda _account, _container: fake)
    (tmp_path / "user-1" / "logs" / "2026-04-27_05-03(P1W1)").mkdir(parents=True)

    assert content_store.list_week_folders("user-1") == [
        "2026-04-27_05-03(P1W1)",
        "2026-04-20_04-26(W0)",
    ]


def test_rejects_path_traversal():
    with pytest.raises(ValueError):
        content_store.read_text("../secret.txt")
