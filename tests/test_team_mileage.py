"""Tests for the GET /api/teams/{team_id}/mileage endpoint.

Auth-service is monkeypatched. Each test seeds tmp_path/{user_id}/coros.db
with a handful of activities and verifies the rankings / period boundaries.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient


USER_A = "a1b2c3d4-e5f6-4aaa-89ab-111111111111"
USER_B = "b1b2c3d4-e5f6-4aaa-89ab-222222222222"
USER_C = "c1b2c3d4-e5f6-4aaa-89ab-333333333333"

SHANGHAI = timezone(timedelta(hours=8))


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


def _make_token(private_pem: str, sub: str) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "iss": "auth-service", "exp": now + 3600, "iat": now, "role": "user"},
        private_pem,
        algorithm="RS256",
    )


def _seed_activity(user_data_dir, user_id: str, label_id: str, date_iso: str,
                   distance_km: float, sport_type: int = 100) -> None:
    from stride_core.db import Database
    user_dir = user_data_dir / user_id
    user_dir.mkdir(parents=True, exist_ok=True)
    db = Database(user_dir / "coros.db")
    db._conn.execute(
        """INSERT OR REPLACE INTO activities
            (label_id, name, sport_type, sport_name, date, distance_m,
             duration_s, avg_pace_s_km, avg_hr, max_hr, training_load,
             vo2max, train_type)
            VALUES (?, 'Run', ?, 'Run', ?, ?, 3000, 300, 150, 170, 100, 50, 'easy')""",
        (label_id, sport_type, date_iso, distance_km),
    )
    db._conn.commit()
    db.close()


@pytest.fixture
def app_client(tmp_path, monkeypatch, rsa_keypair):
    private_pem, public_pem = rsa_keypair

    import stride_server.bearer as bearer
    monkeypatch.setattr(bearer, "_cached_public_key", public_pem)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for key in ("STRIDE_AUTH_PUBLIC_KEY_PEM", "STRIDE_AUTH_PUBLIC_KEY_PATH",
                "STRIDE_AUTH_ISSUER", "STRIDE_AUTH_AUDIENCE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)

    import stride_server.routes.teams as teams_mod
    monkeypatch.setattr(teams_mod, "USER_DATA_DIR", tmp_path)

    from stride_server.bearer import require_bearer
    from stride_server.routes.teams import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer)])

    token_a = _make_token(private_pem, USER_A)
    token_outsider = _make_token(private_pem, USER_C)
    client = TestClient(app, raise_server_exceptions=False)
    return client, token_a, token_outsider, tmp_path


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _stub_members(monkeypatch, members: list[dict]):
    async def fake_list_members(_bearer, _team_id):
        return members
    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "list_members", fake_list_members)


# ---------------------------------------------------------------------------
# _period_window unit tests
# ---------------------------------------------------------------------------


def test_period_window_month_at_shanghai_first():
    from stride_server.routes.teams import _period_window
    # Mon 2026-05-04 13:00 UTC = 21:00 Shanghai (still May).
    fixed = datetime(2026, 5, 4, 13, 0, tzinfo=timezone.utc)
    start, end = _period_window("month", now_utc=fixed)
    assert start.isoformat() == "2026-05-01T00:00:00+08:00"
    assert end.tzinfo == SHANGHAI


def test_period_window_week_starts_monday():
    from stride_server.routes.teams import _period_window
    # Wed 2026-05-06 04:00 UTC = 12:00 Shanghai Wed → Monday is 2026-05-04
    fixed = datetime(2026, 5, 6, 4, 0, tzinfo=timezone.utc)
    start, _ = _period_window("week", now_utc=fixed)
    assert start.isoformat() == "2026-05-04T00:00:00+08:00"


def test_period_window_month_boundary_late_night_utc():
    """A late-night UTC moment that's already next-day in Shanghai must use
    the Shanghai-local month/week, not UTC's."""
    from stride_server.routes.teams import _period_window
    # 2026-04-30 17:00 UTC = 2026-05-01 01:00 Shanghai → period starts May 1.
    fixed = datetime(2026, 4, 30, 17, 0, tzinfo=timezone.utc)
    start, _ = _period_window("month", now_utc=fixed)
    assert start.isoformat() == "2026-05-01T00:00:00+08:00"


def test_period_window_invalid_raises():
    from stride_server.routes.teams import _period_window
    with pytest.raises(ValueError):
        _period_window("year")


# ---------------------------------------------------------------------------
# Endpoint tests
# ---------------------------------------------------------------------------


def test_mileage_returns_ranked_members(app_client, monkeypatch):
    client, token_a, _, tmp_path = app_client

    # Seed 3 members with distinct mileage in the current month.
    today = datetime.now(SHANGHAI)
    first_of_month = today.replace(day=1, hour=12, minute=0, second=0, microsecond=0)
    iso_today = today.astimezone(timezone.utc).isoformat()
    iso_two_days_ago = (today - timedelta(days=2)).astimezone(timezone.utc).isoformat()

    _seed_activity(tmp_path, USER_A, "a1", iso_today, 12.5)
    _seed_activity(tmp_path, USER_A, "a2", iso_two_days_ago, 8.0)
    _seed_activity(tmp_path, USER_B, "b1", iso_today, 21.1)
    # USER_C: nothing in current month.

    _stub_members(monkeypatch, [
        {"user_id": USER_A, "name": "Alice", "role": "member"},
        {"user_id": USER_B, "name": "Bob", "role": "owner"},
        {"user_id": USER_C, "name": "Carol", "role": "member"},
    ])

    resp = client.get("/api/teams/t1/mileage?period=month", headers=_auth(token_a))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["period"] == "month"
    assert len(data["rankings"]) == 3

    # Bob top (21.1), Alice next (20.5), Carol last (0).
    rankings = data["rankings"]
    assert rankings[0]["user_id"] == USER_B
    assert rankings[0]["total_km"] == 21.1
    assert rankings[0]["activity_count"] == 1
    assert rankings[1]["user_id"] == USER_A
    assert rankings[1]["total_km"] == 20.5
    assert rankings[1]["activity_count"] == 2
    assert rankings[2]["user_id"] == USER_C
    assert rankings[2]["total_km"] == 0
    assert rankings[2]["activity_count"] == 0
    # Period start is the first of the current month, Shanghai TZ.
    assert data["period_start"].endswith("+08:00")


def test_mileage_excludes_pre_period_activities(app_client, monkeypatch):
    """Activities older than the natural-month start must not count."""
    client, token_a, _, tmp_path = app_client

    today = datetime.now(SHANGHAI)
    last_month = (today.replace(day=1) - timedelta(days=5)).astimezone(timezone.utc)
    _seed_activity(tmp_path, USER_A, "old", last_month.isoformat(), 50.0)
    _seed_activity(tmp_path, USER_A, "new",
                   today.astimezone(timezone.utc).isoformat(), 5.0)

    _stub_members(monkeypatch, [{"user_id": USER_A, "name": "Alice", "role": "owner"}])

    resp = client.get("/api/teams/t1/mileage?period=month", headers=_auth(token_a))
    assert resp.status_code == 200
    data = resp.json()
    # Only the 5km counts; the 50km from last month is excluded.
    assert data["rankings"][0]["total_km"] == 5.0
    assert data["rankings"][0]["activity_count"] == 1


def test_mileage_excludes_non_running_sports(app_client, monkeypatch):
    """Non-running sport_types (e.g. 4=strength) must not contribute to
    the running mileage total."""
    client, token_a, _, tmp_path = app_client

    today = datetime.now(SHANGHAI).astimezone(timezone.utc).isoformat()
    _seed_activity(tmp_path, USER_A, "run", today, 8.0, sport_type=100)
    _seed_activity(tmp_path, USER_A, "lift", today, 0.5, sport_type=4)

    _stub_members(monkeypatch, [{"user_id": USER_A, "name": "Alice", "role": "owner"}])

    resp = client.get("/api/teams/t1/mileage?period=month", headers=_auth(token_a))
    data = resp.json()
    assert data["rankings"][0]["total_km"] == 8.0
    assert data["rankings"][0]["activity_count"] == 1


def test_mileage_403_for_non_member(app_client, monkeypatch):
    client, _, token_outsider, _ = app_client
    _stub_members(monkeypatch, [{"user_id": USER_A, "name": "Alice", "role": "owner"}])
    resp = client.get("/api/teams/t1/mileage?period=month", headers=_auth(token_outsider))
    assert resp.status_code == 403


def test_mileage_invalid_period_422(app_client, monkeypatch):
    client, token_a, _, _ = app_client
    _stub_members(monkeypatch, [{"user_id": USER_A, "name": "Alice", "role": "owner"}])
    resp = client.get("/api/teams/t1/mileage?period=year", headers=_auth(token_a))
    assert resp.status_code == 422


def test_mileage_week_period_supported(app_client, monkeypatch):
    """Smoke test that ?period=week returns a valid response."""
    client, token_a, _, tmp_path = app_client
    today = datetime.now(SHANGHAI).astimezone(timezone.utc).isoformat()
    _seed_activity(tmp_path, USER_A, "run-this-week", today, 6.0)
    _stub_members(monkeypatch, [{"user_id": USER_A, "name": "Alice", "role": "owner"}])

    resp = client.get("/api/teams/t1/mileage?period=week", headers=_auth(token_a))
    assert resp.status_code == 200
    data = resp.json()
    assert data["period"] == "week"
    assert data["rankings"][0]["total_km"] == 6.0


def test_mileage_handles_member_without_db(app_client, monkeypatch):
    """A team member with no STRIDE coros.db comes back with zeroes, not error."""
    client, token_a, _, tmp_path = app_client
    today = datetime.now(SHANGHAI).astimezone(timezone.utc).isoformat()
    _seed_activity(tmp_path, USER_A, "run", today, 6.0)
    # USER_B never seeded.

    _stub_members(monkeypatch, [
        {"user_id": USER_A, "name": "Alice", "role": "owner"},
        {"user_id": USER_B, "name": "Bob", "role": "member"},
    ])

    resp = client.get("/api/teams/t1/mileage?period=month", headers=_auth(token_a))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["rankings"]) == 2
    # Alice first, Bob (zero) last.
    assert data["rankings"][0]["user_id"] == USER_A
    assert data["rankings"][1]["user_id"] == USER_B
    assert data["rankings"][1]["total_km"] == 0
