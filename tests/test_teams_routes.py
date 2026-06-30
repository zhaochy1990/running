"""Tests for /api/teams/* and /api/users/me/teams endpoints.

These tests do NOT hit the real auth-service. They monkeypatch
``stride_server.auth_service_client`` so each route's behaviour can be
exercised in isolation. The cross-user activity feed test uses a real
SQLite Database fixture with USER_DATA_DIR pointed at tmp_path.
"""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from stride_server.config.models import (
    AuthServiceConfig,
    JPushConfig,
    NotificationStorageConfig,
)


USER_A = "a1b2c3d4-e5f6-4aaa-89ab-111111111111"
USER_B = "b1b2c3d4-e5f6-4aaa-89ab-222222222222"


def test_notifications_backend_uses_config_file_backend() -> None:
    from stride_server.notifications.store import backend_from_config

    backend = backend_from_config(
        NotificationStorageConfig(
            table_account_url="",
            devices_table="stridedevices",
            prefs_table="strideprefs",
        )
    )

    assert backend.__class__.__name__ == "FileNotificationsBackend"


def test_jpush_credentials_from_config() -> None:
    from stride_server.notifications.jpush_client import credentials_from_config

    cfg = JPushConfig(app_key="app", master_secret="secret")

    assert credentials_from_config(cfg) == ("app", "secret")


def test_auth_service_base_url_from_config() -> None:
    from stride_server.auth_service_client import base_url_from_config

    assert (
        base_url_from_config(AuthServiceConfig(base_url="https://auth.example/", timeout_s=2.0))
        == "https://auth.example"
    )


def test_auth_service_base_url_from_config_raises_when_empty() -> None:
    from stride_server.auth_service_client import AuthServiceUnavailable, base_url_from_config

    with pytest.raises(AuthServiceUnavailable, match="auth_service.base_url"):
        base_url_from_config(AuthServiceConfig(base_url="", timeout_s=2.0))


def test_notifications_backend_uses_legacy_likes_url_when_dedicated_env_blank(monkeypatch) -> None:
    from stride_server.notifications import store as nstore


    monkeypatch.setenv(nstore.ACCOUNT_URL_ENV, "")
    monkeypatch.setenv(nstore.LEGACY_ACCOUNT_URL_ENV, "https://acct.table.core.windows.net")
    nstore.reset_backend_cache()

    backend = nstore._get_backend()

    assert backend.__class__.__name__ == "AzureTableNotificationsBackend"
    nstore.reset_backend_cache()


# ---------------------------------------------------------------------------
# RSA key + token helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def rsa_keypair():
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = private.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return private_pem, public_pem


def _make_token(private_pem: str, sub: str = USER_A) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "iss": "auth-service", "exp": now + 3600, "iat": now, "role": "user"},
        private_pem,
        algorithm="RS256",
    )


# ---------------------------------------------------------------------------
# App + auth-service stub fixture
# ---------------------------------------------------------------------------


@pytest.fixture
def app_client(tmp_path, monkeypatch, rsa_keypair):
    """TestClient mounting only the teams router, with bearer configured and
    auth_service_client functions stubbed.
    """
    private_pem, public_pem = rsa_keypair

    import stride_server.bearer as bearer
    monkeypatch.setattr(bearer, "_cached_public_key", public_pem)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for key in ("STRIDE_AUTH_PUBLIC_KEY_PEM", "STRIDE_AUTH_PUBLIC_KEY_PATH",
                "STRIDE_AUTH_ISSUER", "STRIDE_AUTH_AUDIENCE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)

    # Point USER_DATA_DIR at tmp_path so the feed endpoint reads test DBs.
    import stride_server.routes.teams as teams_mod
    monkeypatch.setattr(teams_mod, "USER_DATA_DIR", tmp_path)

    from stride_server.bearer import require_bearer
    from stride_server.routes.teams import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer)])

    token = _make_token(private_pem)
    client = TestClient(app, raise_server_exceptions=False)
    return client, token, tmp_path


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Tests — proxy endpoints with stubbed auth-service
# ---------------------------------------------------------------------------


def test_list_teams_proxies_auth_service(app_client, monkeypatch):
    client, token, _ = app_client

    fake_teams = [
        {"id": "t1", "name": "STRIDE", "is_open": True, "member_count": 3},
        {"id": "t2", "name": "Track Club", "is_open": True, "member_count": 5},
    ]

    async def fake_list_teams(_bearer):
        return fake_teams

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "list_teams", fake_list_teams)

    resp = client.get("/api/teams", headers=_auth(token))
    assert resp.status_code == 200
    data = resp.json()
    assert data == {"teams": fake_teams}


def test_list_teams_returns_empty_when_auth_service_unconfigured(app_client, monkeypatch):
    """STRIDE_AUTH_URL unset → graceful empty list (acceptance D)."""
    client, token, _ = app_client
    monkeypatch.delenv("STRIDE_AUTH_URL", raising=False)

    resp = client.get("/api/teams", headers=_auth(token))
    assert resp.status_code == 200
    assert resp.json() == {"teams": []}


def test_create_team_validates_name(app_client):
    client, token, _ = app_client
    resp = client.post("/api/teams", json={"name": ""}, headers=_auth(token))
    assert resp.status_code == 422


def test_create_team_proxies(app_client, monkeypatch):
    client, token, _ = app_client
    seen: dict = {}

    async def fake_create_team(_bearer, name, description=None):
        seen["name"] = name
        seen["description"] = description
        return {"id": "new", "name": name, "owner_user_id": USER_A}

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "create_team", fake_create_team)

    resp = client.post(
        "/api/teams",
        json={"name": "Sub-3 Club", "description": "Marathon nerds"},
        headers=_auth(token),
    )
    assert resp.status_code == 200
    assert seen == {"name": "Sub-3 Club", "description": "Marathon nerds"}
    assert resp.json()["name"] == "Sub-3 Club"


def test_get_team_404(app_client, monkeypatch):
    client, token, _ = app_client

    async def fake_get_team(_bearer, _team_id):
        return None

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "get_team", fake_get_team)

    resp = client.get("/api/teams/nonexistent", headers=_auth(token))
    assert resp.status_code == 404


def test_join_team_surfaces_auth_service_4xx(app_client, monkeypatch):
    client, token, _ = app_client

    import stride_server.auth_service_client as ac

    async def fake_join(_bearer, _team_id):
        raise ac.AuthServiceError(403, "team is closed")

    monkeypatch.setattr(ac, "join_team", fake_join)

    resp = client.post("/api/teams/t1/join", headers=_auth(token))
    assert resp.status_code == 403


def test_join_team_503_when_auth_service_unavailable(app_client, monkeypatch):
    client, token, _ = app_client

    import stride_server.auth_service_client as ac

    async def fake_join(_bearer, _team_id):
        raise ac.AuthServiceUnavailable("connection refused")

    monkeypatch.setattr(ac, "join_team", fake_join)

    resp = client.post("/api/teams/t1/join", headers=_auth(token))
    assert resp.status_code == 503


def test_transfer_owner_proxies(app_client, monkeypatch):
    client, token, _ = app_client
    seen: dict = {}

    async def fake_transfer(_bearer, team_id, new_owner_user_id):
        seen["team_id"] = team_id
        seen["new_owner_user_id"] = new_owner_user_id
        return {"id": team_id, "owner_user_id": new_owner_user_id}

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "transfer_team_owner", fake_transfer)

    resp = client.post(
        "/api/teams/t1/transfer-owner",
        json={"new_owner_user_id": USER_B},
        headers=_auth(token),
    )
    assert resp.status_code == 200
    assert seen == {"team_id": "t1", "new_owner_user_id": USER_B}
    assert resp.json()["owner_user_id"] == USER_B


def test_transfer_owner_validates_target_uuid(app_client):
    client, token, _ = app_client
    resp = client.post(
        "/api/teams/t1/transfer-owner",
        json={"new_owner_user_id": "not-a-uuid"},
        headers=_auth(token),
    )
    assert resp.status_code == 422


def test_delete_team_proxies(app_client, monkeypatch):
    client, token, _ = app_client
    seen: dict = {}

    async def fake_delete(_bearer, team_id):
        seen["team_id"] = team_id

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "delete_team", fake_delete)

    resp = client.delete("/api/teams/t1", headers=_auth(token))
    assert resp.status_code == 200
    assert seen == {"team_id": "t1"}
    assert resp.json() == {"status": "deleted"}


def test_delete_team_surfaces_auth_service_4xx(app_client, monkeypatch):
    client, token, _ = app_client

    import stride_server.auth_service_client as ac

    async def fake_delete(_bearer, _team_id):
        raise ac.AuthServiceError(403, "owner required")

    monkeypatch.setattr(ac, "delete_team", fake_delete)

    resp = client.delete("/api/teams/t1", headers=_auth(token))
    assert resp.status_code == 403


def test_my_teams_returns_empty_when_unconfigured(app_client):
    client, token, _ = app_client
    resp = client.get("/api/users/me/teams", headers=_auth(token))
    assert resp.status_code == 200
    assert resp.json() == {"teams": []}


# ---------------------------------------------------------------------------
# Cross-user activity feed
# ---------------------------------------------------------------------------


def _seed_user_db(user_data_dir, user_id: str, activities: list[dict]) -> None:
    """Create data/{user_id}/coros.db with the given activity rows."""
    from stride_core.db import Database

    user_dir = user_data_dir / user_id
    user_dir.mkdir(parents=True, exist_ok=True)
    db = Database(user_dir / "coros.db")
    for a in activities:
        # The Database class has an upsert_activity helper but for testing we
        # use raw SQL via _conn to keep the test independent of higher-level
        # APIs.
        db._conn.execute(
            """INSERT OR REPLACE INTO activities
                (label_id, name, sport_type, sport_name, date, distance_m,
                 duration_s, avg_pace_s_km, avg_hr, max_hr, training_load,
                 vo2max, train_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                a["label_id"],
                a.get("name"),
                a.get("sport_type", 100),
                a.get("sport_name", "Run"),
                a["date"],
                a.get("distance_m", 10.0),
                a.get("duration_s", 3000),
                a.get("avg_pace_s_km"),
                a.get("avg_hr"),
                a.get("max_hr"),
                a.get("training_load"),
                a.get("vo2max"),
                a.get("train_type"),
            ),
        )
    db._conn.commit()
    db.close()


def test_feed_unifies_member_activities(app_client, monkeypatch):
    client, token, tmp_path = app_client

    # Seed two members' DBs with activities.
    from datetime import datetime, timedelta, timezone
    today = datetime.now(timezone.utc)
    yesterday = today - timedelta(days=1)
    two_days_ago = today - timedelta(days=2)

    _seed_user_db(tmp_path, USER_A, [
        {"label_id": "a1", "date": today.isoformat(), "distance_m": 12.5},
        {"label_id": "a2", "date": two_days_ago.isoformat(), "distance_m": 8.0},
    ])
    _seed_user_db(tmp_path, USER_B, [
        {"label_id": "b1", "date": yesterday.isoformat(), "distance_m": 21.1},
    ])

    async def fake_list_members(_bearer, _team_id):
        return [
            {"user_id": USER_A, "name": "Alice", "role": "owner"},
            {"user_id": USER_B, "name": "Bob", "role": "member"},
        ]

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "list_members", fake_list_members)

    resp = client.get("/api/teams/t1/feed?days=7", headers=_auth(token))
    assert resp.status_code == 200
    data = resp.json()
    assert data["team_id"] == "t1"
    assert data["member_count"] == 2

    # Activities sorted by date desc; tagged with user_id + display_name.
    label_ids = [a["label_id"] for a in data["activities"]]
    assert label_ids == ["a1", "b1", "a2"]

    by_id = {a["label_id"]: a for a in data["activities"]}
    assert by_id["a1"]["user_id"] == USER_A
    assert by_id["a1"]["display_name"] == "Alice"
    assert by_id["b1"]["display_name"] == "Bob"


def test_feed_skips_member_with_no_db(app_client, monkeypatch, tmp_path):
    """A team member without a STRIDE coros.db is silently skipped."""
    client, token, tmp_path = app_client

    async def fake_list_members(_bearer, _team_id):
        return [
            {"user_id": USER_A, "name": "Alice", "role": "owner"},
            {"user_id": "00000000-0000-4000-8000-000000000000", "name": "Ghost", "role": "member"},
        ]

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "list_members", fake_list_members)

    resp = client.get("/api/teams/t1/feed", headers=_auth(token))
    assert resp.status_code == 200
    data = resp.json()
    assert data["member_count"] == 2
    # Only Alice (no DB) → empty feed, but the call still succeeds.
    assert isinstance(data["activities"], list)


# ---------------------------------------------------------------------------
# STRIDE display_name enrichment
# ---------------------------------------------------------------------------


def _seed_profile(user_data_dir, user_id: str, display_name: str | None) -> None:
    import json as _json

    user_dir = user_data_dir / user_id
    user_dir.mkdir(parents=True, exist_ok=True)
    payload: dict = {}
    if display_name is not None:
        payload["display_name"] = display_name
    (user_dir / "profile.json").write_text(_json.dumps(payload), encoding="utf-8")


def test_list_members_uses_stride_display_name(app_client, monkeypatch):
    """STRIDE profile.json display_name beats auth-service ``name``."""
    client, token, tmp_path = app_client
    _seed_profile(tmp_path, USER_A, "ChaoyiPro")

    async def fake_list_members(_bearer, _team_id):
        return [
            {"user_id": USER_A, "name": "362339669", "role": "owner"},
        ]

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "list_members", fake_list_members)

    resp = client.get("/api/teams/t1/members", headers=_auth(token))
    assert resp.status_code == 200
    members = resp.json()["members"]
    assert len(members) == 1
    assert members[0]["display_name"] == "ChaoyiPro"
    # Original auth-service name still passed through (so the UI can display it
    # as a fallback hint if it wants).
    assert members[0]["name"] == "362339669"


def test_list_members_falls_back_to_auth_name(app_client, monkeypatch):
    """No profile.json → use auth-service ``name`` as display_name."""
    client, token, _tmp_path = app_client

    async def fake_list_members(_bearer, _team_id):
        return [
            {"user_id": USER_A, "name": "Alice", "role": "owner"},
        ]

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "list_members", fake_list_members)

    resp = client.get("/api/teams/t1/members", headers=_auth(token))
    members = resp.json()["members"]
    assert members[0]["display_name"] == "Alice"


def test_list_members_falls_back_when_profile_missing_display_name(app_client, monkeypatch):
    """profile.json present but lacks display_name → fall back to auth name."""
    client, token, tmp_path = app_client
    _seed_profile(tmp_path, USER_A, None)

    async def fake_list_members(_bearer, _team_id):
        return [{"user_id": USER_A, "name": "Alice", "role": "owner"}]

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "list_members", fake_list_members)

    members = client.get("/api/teams/t1/members", headers=_auth(token)).json()["members"]
    assert members[0]["display_name"] == "Alice"


def test_team_feed_uses_stride_display_name(app_client, monkeypatch):
    """Feed activity entries pick up STRIDE display_name from profile.json."""
    client, token, tmp_path = app_client
    _seed_profile(tmp_path, USER_A, "ChaoyiPro")
    _seed_profile(tmp_path, USER_B, None)  # no display_name

    from datetime import datetime, timedelta, timezone
    today = datetime.now(timezone.utc)
    yesterday = today - timedelta(days=1)
    _seed_user_db(tmp_path, USER_A, [
        {"label_id": "a1", "date": today.isoformat(), "distance_m": 12.5},
    ])
    _seed_user_db(tmp_path, USER_B, [
        {"label_id": "b1", "date": yesterday.isoformat(), "distance_m": 21.1},
    ])

    async def fake_list_members(_bearer, _team_id):
        return [
            {"user_id": USER_A, "name": "362339669", "role": "owner"},
            {"user_id": USER_B, "name": "Bob", "role": "member"},
        ]

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "list_members", fake_list_members)

    resp = client.get("/api/teams/t1/feed?days=7", headers=_auth(token))
    assert resp.status_code == 200
    by_id = {a["label_id"]: a for a in resp.json()["activities"]}
    assert by_id["a1"]["display_name"] == "ChaoyiPro"   # stride wins
    assert by_id["b1"]["display_name"] == "Bob"           # falls back to auth name


def test_list_members_handles_invalid_user_id_safely(app_client, monkeypatch):
    """Malformed user_id (non-UUID) shouldn't crash; just no STRIDE lookup."""
    client, token, _ = app_client

    async def fake_list_members(_bearer, _team_id):
        return [{"user_id": "../etc/passwd", "name": "Sketchy", "role": "member"}]

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "list_members", fake_list_members)

    resp = client.get("/api/teams/t1/members", headers=_auth(token))
    assert resp.status_code == 200
    members = resp.json()["members"]
    assert members[0]["display_name"] == "Sketchy"


# ---------------------------------------------------------------------------
# /sync-all — mixed-provider dispatch
# ---------------------------------------------------------------------------


class _FakeAdapter:
    """Minimal DataSource stand-in for sync-all dispatch tests."""

    def __init__(
        self,
        name: str,
        *,
        logged_in: bool = True,
        sync_activities: int = 0,
        sync_health: int = 0,
    ) -> None:
        from stride_core.source import ProviderInfo
        self.name = name
        self._info = ProviderInfo(
            name=name, display_name=name, regions=("global",), capabilities=frozenset(),
        )
        self._logged_in = logged_in
        self._sync_activities = sync_activities
        self._sync_health = sync_health
        self.calls: list[tuple[str, str]] = []

    @property
    def info(self):
        return self._info

    def is_logged_in(self, user: str) -> bool:
        self.calls.append(("is_logged_in", user))
        return self._logged_in

    def sync_user(self, user: str, *, full: bool = False, **_kwargs):
        from stride_core.source import SyncResult
        self.calls.append(("sync_user", user))
        return SyncResult(activities=self._sync_activities, health=self._sync_health)


class _FakeRegistry:
    """ProviderRegistry stand-in keyed by user_id → adapter."""

    def __init__(self, by_user: dict[str, _FakeAdapter]) -> None:
        self._by_user = by_user

    def for_user(self, user: str):
        from stride_core.registry import UnknownProvider
        if user not in self._by_user:
            raise UnknownProvider("unknown")
        return self._by_user[user]


def _override_registry(client, registry):
    from stride_server.deps import get_registry
    client.app.dependency_overrides[get_registry] = lambda: registry


def test_sync_all_dispatches_per_user_provider(app_client, monkeypatch):
    """Mixed COROS+Garmin team: each user must hit their own adapter, not a single default."""
    client, token, _ = app_client

    coros_adapter = _FakeAdapter(name="coros", sync_activities=4, sync_health=84)
    garmin_adapter = _FakeAdapter(name="garmin", sync_activities=17, sync_health=57)
    registry = _FakeRegistry({USER_A: coros_adapter, USER_B: garmin_adapter})
    _override_registry(client, registry)

    async def fake_list_members(_bearer, _team_id):
        return [
            {"user_id": USER_A, "name": "AliceCoros", "role": "owner"},
            {"user_id": USER_B, "name": "BobGarmin", "role": "member"},
        ]

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "list_members", fake_list_members)

    resp = client.post("/api/teams/t1/sync-all", headers=_auth(token))
    assert resp.status_code == 200
    data = resp.json()

    # Each adapter should have been queried for its OWN user only.
    assert ("is_logged_in", USER_A) in coros_adapter.calls
    assert ("sync_user", USER_A) in coros_adapter.calls
    assert ("is_logged_in", USER_B) in garmin_adapter.calls
    assert ("sync_user", USER_B) in garmin_adapter.calls
    # And NEVER cross-dispatched.
    assert all(call[1] != USER_B for call in coros_adapter.calls)
    assert all(call[1] != USER_A for call in garmin_adapter.calls)

    by_user = {r["user_id"]: r for r in data["results"]}
    assert by_user[USER_A]["status"] == "synced"
    assert by_user[USER_A]["provider"] == "coros"
    assert by_user[USER_A]["new_activities"] == 4
    assert by_user[USER_B]["status"] == "synced"
    assert by_user[USER_B]["provider"] == "garmin"
    assert by_user[USER_B]["new_activities"] == 17

    assert data["totals"]["synced"] == 2
    assert data["totals"]["new_activities"] == 21
    assert data["totals"]["new_health"] == 141


def test_sync_all_skips_member_not_logged_in_on_their_provider(app_client, monkeypatch):
    """Garmin-bound user with no Garmin token gets skipped, NOT marked as COROS-skipped."""
    client, token, _ = app_client

    coros_adapter = _FakeAdapter(name="coros", sync_activities=2, sync_health=42)
    garmin_adapter = _FakeAdapter(name="garmin", logged_in=False)  # ← key: not logged in
    registry = _FakeRegistry({USER_A: coros_adapter, USER_B: garmin_adapter})
    _override_registry(client, registry)

    async def fake_list_members(_bearer, _team_id):
        return [
            {"user_id": USER_A, "name": "AliceCoros", "role": "owner"},
            {"user_id": USER_B, "name": "BobGarmin", "role": "member"},
        ]

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "list_members", fake_list_members)

    resp = client.post("/api/teams/t1/sync-all", headers=_auth(token))
    assert resp.status_code == 200
    data = resp.json()

    by_user = {r["user_id"]: r for r in data["results"]}
    assert by_user[USER_A]["status"] == "synced"
    assert by_user[USER_B]["status"] == "skipped_no_auth"
    assert by_user[USER_B]["provider"] == "garmin"

    # Critical: Garmin user must NOT have been routed to the COROS adapter.
    assert all(call[1] != USER_B for call in coros_adapter.calls)
    # Garmin adapter was queried but sync_user was never reached.
    assert ("is_logged_in", USER_B) in garmin_adapter.calls
    assert all(call[0] != "sync_user" for call in garmin_adapter.calls)

    assert data["totals"]["synced"] == 1
    assert data["totals"]["skipped"] == 1


def test_sync_all_marks_unknown_provider_as_error(app_client, monkeypatch):
    """A user bound to a provider this deployment doesn't ship surfaces as `error`, not skipped."""
    client, token, _ = app_client

    coros_adapter = _FakeAdapter(name="coros")
    registry = _FakeRegistry({USER_A: coros_adapter})  # USER_B not in registry
    _override_registry(client, registry)

    async def fake_list_members(_bearer, _team_id):
        return [
            {"user_id": USER_A, "name": "Alice", "role": "owner"},
            {"user_id": USER_B, "name": "Bob", "role": "member"},
        ]

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "list_members", fake_list_members)

    resp = client.post("/api/teams/t1/sync-all", headers=_auth(token))
    assert resp.status_code == 200
    data = resp.json()

    by_user = {r["user_id"]: r for r in data["results"]}
    assert by_user[USER_A]["status"] == "synced"
    assert by_user[USER_B]["status"] == "error"
    assert "unknown provider" in by_user[USER_B]["error"]
    assert data["totals"]["errors"] == 1


def test_sync_all_rejects_non_member_caller(app_client, monkeypatch):
    """Caller must be a member of the team — even though Bearer is valid."""
    client, token, _ = app_client

    registry = _FakeRegistry({})
    _override_registry(client, registry)

    async def fake_list_members(_bearer, _team_id):
        # Caller (USER_A from token) is NOT in this list.
        return [{"user_id": USER_B, "name": "Bob", "role": "owner"}]

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "list_members", fake_list_members)

    resp = client.post("/api/teams/t1/sync-all", headers=_auth(token))
    assert resp.status_code == 403
