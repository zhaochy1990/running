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


USER_A = "a1b2c3d4-e5f6-4aaa-89ab-111111111111"
USER_B = "b1b2c3d4-e5f6-4aaa-89ab-222222222222"


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
