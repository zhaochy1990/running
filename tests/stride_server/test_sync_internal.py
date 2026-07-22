"""Tests for the internal POST /internal/sync endpoint.

Mirrors the test pattern from test_training_load_backfill.py: build a minimal
FastAPI app mounting only the internal_router, stub the data source registry
on app.state, and exercise the route with TestClient.
"""

from __future__ import annotations

import sqlite3

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from stride_core.source import ProviderInfo, SyncResult

INTERNAL_TOKEN = "test-internal-token-12345678"
USER_UUID = "f10bc353-01ab-4db1-af9f-d9305ea9a532"  # valid UUID4, from .slug_aliases.json


class FakeSource:
    """Minimal DataSource stand-in. Only the attrs the route reads."""

    def __init__(self, logged_in: bool = True, activities: int = 7, health: int = 1):
        self._logged_in = logged_in
        self._activities = activities
        self._health = health
        self.info = ProviderInfo(
            name="coros",
            display_name="高驰",
            regions=("global",),
            capabilities=frozenset(),
        )

    def is_logged_in(self, user: str) -> bool:
        return self._logged_in

    def sync_user(self, user: str, full: bool = False) -> SyncResult:
        return SyncResult(activities=self._activities, health=self._health)


class FakeRegistry:
    def __init__(self, source: FakeSource):
        self._source = source

    def for_user(self, user: str) -> FakeSource:
        return self._source


def _build_app(monkeypatch, source: FakeSource | None = None) -> FastAPI:
    """Build a minimal app with just internal_router mounted, registry stubbed."""
    monkeypatch.setenv("STRIDE_INTERNAL_TOKEN", INTERNAL_TOKEN)

    import stride_server.routes.sync as sync_mod
    from stride_server.config import clear_server_config_cache

    # No-op storage boundaries so tests don't touch persistent job state / DB.
    monkeypatch.setattr(sync_mod, "reject_deleting_user", lambda _user: None)
    monkeypatch.setattr(sync_mod, "run_post_sync_for_result", lambda **kw: None)
    clear_server_config_cache()

    app = FastAPI()
    app.state.registry = FakeRegistry(source or FakeSource())
    app.include_router(sync_mod.internal_router)
    return app


def test_missing_internal_token_returns_401(monkeypatch):
    app = _build_app(monkeypatch)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(f"/internal/sync?user={USER_UUID}")

    assert resp.status_code == 401, resp.text


def test_bad_internal_token_returns_401(monkeypatch):
    app = _build_app(monkeypatch)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        f"/internal/sync?user={USER_UUID}",
        headers={"X-Internal-Token": "wrong-token-value"},
    )

    assert resp.status_code == 401, resp.text


def test_invalid_uuid_returns_422(monkeypatch):
    app = _build_app(monkeypatch)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        "/internal/sync?user=not-a-uuid",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )

    assert resp.status_code == 422, resp.text
    assert "UUID4" in resp.json()["detail"]


def test_happy_path_returns_200_and_calls_sync_user(monkeypatch):
    calls: list[tuple[str, bool]] = []

    class RecordingSource(FakeSource):
        def sync_user(self, user: str, full: bool = False) -> SyncResult:
            calls.append((user, full))
            return SyncResult(activities=3, health=1)

    source = RecordingSource()
    app = _build_app(monkeypatch, source=source)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        f"/internal/sync?user={USER_UUID}",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is True
    assert "3 条活动" in body["output"]
    assert "1 条健康记录" in body["output"]
    assert calls == [(USER_UUID, False)]


def test_full_flag_forwarded_to_sync_user(monkeypatch):
    calls: list[tuple[str, bool]] = []

    class RecordingSource(FakeSource):
        def sync_user(self, user: str, full: bool = False) -> SyncResult:
            calls.append((user, full))
            return SyncResult(activities=0, health=0)

    source = RecordingSource()
    app = _build_app(monkeypatch, source=source)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        f"/internal/sync?user={USER_UUID}&full=true",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )

    assert resp.status_code == 200, resp.text
    assert calls == [(USER_UUID, True)]


def test_deleted_user_returns_410_without_syncing(monkeypatch):
    import stride_server.routes.sync as sync_mod

    source = FakeSource()
    app = _build_app(monkeypatch, source=source)
    monkeypatch.setattr(
        sync_mod,
        "reject_deleting_user",
        lambda _user: (_ for _ in ()).throw(
            HTTPException(status_code=410, detail="deleted")
        ),
    )
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        f"/internal/sync?user={USER_UUID}",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )

    assert resp.status_code == 410


def test_deletion_fence_is_rechecked_after_writer_lock(monkeypatch):
    import stride_server.routes.sync as sync_mod

    sync_calls: list[tuple[str, bool]] = []
    fence_checks: list[str] = []

    class RecordingSource(FakeSource):
        def sync_user(self, user: str, full: bool = False) -> SyncResult:
            sync_calls.append((user, full))
            return SyncResult(activities=1, health=1)

    app = _build_app(monkeypatch, source=RecordingSource())

    def reject_on_second_check(user: str) -> None:
        fence_checks.append(user)
        if len(fence_checks) == 2:
            raise HTTPException(status_code=410, detail="deleted")

    monkeypatch.setattr(sync_mod, "reject_deleting_user", reject_on_second_check)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        f"/internal/sync?user={USER_UUID}",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )

    assert resp.status_code == 410
    assert fence_checks == [USER_UUID, USER_UUID]
    assert sync_calls == []


def test_writer_busy_returns_retryable_503(monkeypatch):
    from stride_server.sqlite_writer import try_user_sqlite_writer

    calls: list[tuple[str, bool]] = []

    class RecordingSource(FakeSource):
        def sync_user(self, user: str, full: bool = False) -> SyncResult:
            calls.append((user, full))
            return SyncResult(activities=1, health=1)

    app = _build_app(monkeypatch, source=RecordingSource())
    client = TestClient(app, raise_server_exceptions=False)

    with try_user_sqlite_writer(USER_UUID) as acquired:
        assert acquired is True
        resp = client.post(
            f"/internal/sync?user={USER_UUID}",
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )

    assert resp.status_code == 503
    assert resp.headers["Retry-After"] == "2"
    assert resp.json()["detail"] == "user SQLite writer is busy; retry sync later"
    assert calls == []


def test_sqlite_lock_from_sync_returns_retryable_503(monkeypatch):
    class LockedSource(FakeSource):
        def sync_user(self, user: str, full: bool = False) -> SyncResult:
            raise sqlite3.OperationalError("database is locked")

    app = _build_app(monkeypatch, source=LockedSource())
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        f"/internal/sync?user={USER_UUID}",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )

    assert resp.status_code == 503
    assert resp.headers["Retry-After"] == "2"


def test_not_logged_in_returns_success_false(monkeypatch):
    source = FakeSource(logged_in=False)
    app = _build_app(monkeypatch, source=source)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        f"/internal/sync?user={USER_UUID}",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )

    # HTTP is 200 — the route returns a structured error body, not an HTTP error,
    # because the GH Action consumes the body to surface the reason per-user.
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is False
    assert "未登录" in body["error"]
