"""Tests for /api/{user}/home aggregation."""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
OTHER_UUID = "b1b2c3d4-e5f6-4aaa-89ab-123456789012"


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


def _token(private_pem: str, sub: str = USER_UUID) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "iss": "auth-service", "exp": now + 3600, "iat": now, "role": "user"},
        private_pem,
        algorithm="RS256",
    )


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

    import stride_core.db as core_db_mod
    import stride_server.deps as deps_mod
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)

    from stride_server.bearer import require_bearer, verify_path_user
    from stride_server.routes.home import _clear_cache, router

    _clear_cache()

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer), Depends(verify_path_user)])

    client = TestClient(app, raise_server_exceptions=False)
    return client, _token(private_pem), tmp_path, private_pem


def _seed(tmp_path, *, with_data: bool = True, with_provider: str | None = "coros"):
    """Create a per-user DB and optionally a config.json with provider."""
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)
    if with_provider is not None:
        import json
        (user_dir / "config.json").write_text(
            json.dumps({"provider": with_provider}), encoding="utf-8"
        )

    from stride_core.db import Database
    db = Database(user=USER_UUID)
    if with_data:
        from datetime import date
        today = date.today().strftime("%Y%m%d")
        db._conn.execute(
            "INSERT INTO activities (label_id, name, sport_type, date, distance_m, "
            "duration_s, avg_pace_s_km, avg_hr, calories_kcal) VALUES "
            "(?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("L1", "Easy Run", 100, today, 10.0, 3000.0, 300.0, 150, 600),
        )
        db._conn.execute(
            "INSERT INTO activity_commentary (label_id, commentary, generated_by) "
            "VALUES (?, ?, ?)",
            ("L1", "Great session today.\nMore detail.", "gpt-4.1"),
        )
        db._conn.execute(
            "INSERT INTO daily_health (date, ati, cti, training_load_ratio, "
            "training_load_state, fatigue) VALUES (?, ?, ?, ?, ?, ?)",
            ("2026-05-10", 50.0, 60.0, 0.83, "Optimal", 42.0),
        )
        db._conn.execute(
            "INSERT OR REPLACE INTO sync_meta (key, value) VALUES "
            "('last_sync', '2026-05-10T08:00:00')"
        )
        db._conn.commit()
    db.close()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_home_normal_user(app_client):
    client, token, tmp_path, _ = app_client
    _seed(tmp_path)
    resp = client.get(f"/api/{USER_UUID}/home", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["plan_state"] == "none"
    assert data["status_ring"]["fatigue"] == 42.0
    assert data["status_ring"]["fatigue_band"] == "normal"
    assert data["status_ring"]["tsb_band"] == "race_ready"  # ratio 0.83 < 0.85
    assert len(data["recent_activities"]) == 1
    a0 = data["recent_activities"][0]
    assert a0["label_id"] == "L1"
    assert a0["commentary_excerpt"] == "Great session today."
    assert a0["commentary_generated_by"] == "gpt-4.1"
    assert data["lifetime_stats"]["total_activities"] == 1
    assert data["watch"]["brand"] == "coros"
    assert data["watch"]["last_sync_at"] == "2026-05-10T08:00:00"


def test_home_new_user_no_activities(app_client):
    client, token, tmp_path, _ = app_client
    _seed(tmp_path, with_data=False)
    resp = client.get(f"/api/{USER_UUID}/home", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["recent_activities"] == []
    assert data["lifetime_stats"]["total_activities"] == 0
    assert data["status_ring"]["fatigue"] is None
    assert data["weekly_stats"]["session_count"] == 0


def test_home_no_watch(app_client):
    client, token, tmp_path, _ = app_client
    _seed(tmp_path, with_data=False, with_provider=None)
    resp = client.get(f"/api/{USER_UUID}/home", headers=_auth(token))
    assert resp.status_code == 200
    assert resp.json()["watch"]["brand"] is None


def test_home_user_mismatch_403(app_client):
    client, _, tmp_path, private_pem = app_client
    _seed(tmp_path)
    other_token = _token(private_pem, sub=OTHER_UUID)
    resp = client.get(f"/api/{USER_UUID}/home", headers=_auth(other_token))
    assert resp.status_code == 403


def test_home_cache_hit_then_invalidation(app_client, monkeypatch):
    client, token, tmp_path, _ = app_client
    _seed(tmp_path)
    r1 = client.get(f"/api/{USER_UUID}/home", headers=_auth(token))
    assert r1.status_code == 200
    # Insert another activity → without cache invalidation, count stays at 1.
    from stride_core.db import Database
    db = Database(user=USER_UUID)
    db._conn.execute(
        "INSERT INTO activities (label_id, name, sport_type, date, distance_m, duration_s) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ("L2", "Run 2", 100, "20260509", 5.0, 1800.0),
    )
    db._conn.commit()
    db.close()

    r2 = client.get(f"/api/{USER_UUID}/home", headers=_auth(token))
    assert r2.json()["lifetime_stats"]["total_activities"] == 1  # cached

    # Force cache expiry by advancing the monotonic clock.
    import stride_server.routes.home as home_mod
    real_monotonic = time.monotonic
    monkeypatch.setattr(
        home_mod.time, "monotonic", lambda: real_monotonic() + 120.0
    )
    r3 = client.get(f"/api/{USER_UUID}/home", headers=_auth(token))
    assert r3.json()["lifetime_stats"]["total_activities"] == 2
