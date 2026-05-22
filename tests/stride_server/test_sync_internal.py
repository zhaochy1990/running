"""Tests for the internal POST /internal/sync endpoint.

Mirrors the test pattern from test_training_load_backfill.py: build a minimal
FastAPI app mounting only the internal_router, stub the data source registry
on app.state, and exercise the route with TestClient.
"""

from __future__ import annotations

from fastapi import FastAPI
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

    # No-op post-sync hook so tests don't touch DB / external services.
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
