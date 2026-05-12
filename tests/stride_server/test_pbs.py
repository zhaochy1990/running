"""Tests for GET /api/{user}/pbs — personal bests auto-detection."""

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


# ── Shared fixtures (mirrors test_home.py pattern) ────────────────────────────


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
    from stride_server.routes.pbs import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer), Depends(verify_path_user)])

    client = TestClient(app, raise_server_exceptions=False)
    return client, _token(private_pem), tmp_path, private_pem


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _make_db(tmp_path):
    """Return an open Database for USER_UUID, creating the user dir."""
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)
    from stride_core.db import Database
    return Database(user=USER_UUID)


# ── Test cases ────────────────────────────────────────────────────────────────


def test_pbs_multiple_distances(app_client):
    """Multiple 5K and 10K activities → fastest for each distance returned."""
    client, token, tmp_path, _ = app_client
    db = _make_db(tmp_path)
    # sport_type=100 is outdoor run, included in RUN_SPORT_IDS
    db._conn.executemany(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
        "VALUES (?, ?, ?, ?, ?)",
        [
            # 5K runs — slower first, then PB
            ("5K_slow",  100, "2024-01-10", 5000.0, 1500.0),  # 25:00
            ("5K_fast",  100, "2024-06-15", 5000.0, 1290.0),  # 21:30  ← PB
            # 10K runs — PB first, then slower
            ("10K_pb",   100, "2024-02-20", 10000.0, 2700.0),  # 45:00  ← PB
            ("10K_slow", 100, "2024-09-01", 10000.0, 3000.0),  # 50:00
        ],
    )
    db._conn.commit()
    db.close()

    resp = client.get(f"/api/{USER_UUID}/pbs", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data["user_id"] == USER_UUID
    assert "computed_at" in data

    pb_map = {p["distance"]: p for p in data["pbs"]}

    # 5K PB
    assert "5K" in pb_map
    assert pb_map["5K"]["pb_time_sec"] == 1290.0
    assert pb_map["5K"]["label_id"] == "5K_fast"
    assert pb_map["5K"]["achieved_at"] == "2024-06-15"

    # 10K PB
    assert "10K" in pb_map
    assert pb_map["10K"]["pb_time_sec"] == 2700.0
    assert pb_map["10K"]["label_id"] == "10K_pb"

    # No HM or FM seeded → absent from list
    assert "HM" not in pb_map
    assert "FM" not in pb_map


def test_pbs_missing_distance_absent(app_client):
    """User has never run a half marathon → HM absent from pbs list."""
    client, token, tmp_path, _ = app_client
    db = _make_db(tmp_path)
    db._conn.execute(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
        "VALUES (?, ?, ?, ?, ?)",
        ("only_5k", 100, "2025-03-01", 5050.0, 1350.0),
    )
    db._conn.commit()
    db.close()

    resp = client.get(f"/api/{USER_UUID}/pbs", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    distances = [p["distance"] for p in resp.json()["pbs"]]
    assert "HM" not in distances
    assert "FM" not in distances
    assert "5K" in distances


def test_pbs_history_monotonically_decreasing(app_client):
    """history best_so_far_sec must decrease (or equal) with each entry."""
    client, token, tmp_path, _ = app_client
    db = _make_db(tmp_path)
    # Three 5K runs getting progressively faster
    db._conn.executemany(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
        "VALUES (?, ?, ?, ?, ?)",
        [
            ("r1", 100, "2024-01-01", 5000.0, 1800.0),  # 30:00
            ("r2", 100, "2024-04-01", 5000.0, 1600.0),  # 26:40
            ("r3", 100, "2024-08-01", 5000.0, 1380.0),  # 23:00
        ],
    )
    db._conn.commit()
    db.close()

    resp = client.get(f"/api/{USER_UUID}/pbs", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    pb_map = {p["distance"]: p for p in resp.json()["pbs"]}

    history = pb_map["5K"]["history"]
    # All three runs break the PB → 3 entries in history
    assert len(history) == 3
    times = [h["best_so_far_sec"] for h in history]
    # Verify strictly monotonically decreasing (each entry is a new PB)
    for i in range(1, len(times)):
        assert times[i] < times[i - 1], (
            f"history not monotonically decreasing at index {i}: {times}"
        )

    # Final entry matches the overall PB
    assert pb_map["5K"]["pb_time_sec"] == times[-1]


def test_pbs_distance_tolerance_boundary(app_client):
    """5.0 km (exactly 5000m) counts; 5.3 km (5300m) does not."""
    client, token, tmp_path, _ = app_client
    db = _make_db(tmp_path)
    db._conn.executemany(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
        "VALUES (?, ?, ?, ?, ?)",
        [
            ("exact_5k",  100, "2025-01-10", 5000.0, 1350.0),  # 4800–5200 → IN
            ("short_5k",  100, "2025-01-11", 4800.0, 1300.0),  # min boundary → IN
            ("long_5k",   100, "2025-01-12", 5200.0, 1340.0),  # max boundary → IN
            ("too_long",  100, "2025-01-13", 5300.0, 1320.0),  # 5300 > 5200 → OUT
            ("too_short", 100, "2025-01-14", 4700.0, 1280.0),  # 4700 < 4800 → OUT
        ],
    )
    db._conn.commit()
    db.close()

    resp = client.get(f"/api/{USER_UUID}/pbs", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    pb_map = {p["distance"]: p for p in resp.json()["pbs"]}

    assert "5K" in pb_map
    # Best among the three valid candidates (5000m/1350s, 4800m/1300s, 5200m/1340s)
    assert pb_map["5K"]["pb_time_sec"] == 1300.0
    assert pb_map["5K"]["label_id"] == "short_5k"
    # history: exact_5k(1350s) is first PB, short_5k(1300s) breaks it → 2 entries.
    # long_5k(1340s) does NOT break 1300s so it's NOT in history.
    assert len(pb_map["5K"]["history"]) == 2

    # 5300m and 4700m must NOT count toward 5K PBs
    all_label_ids_in_history = [h for p in resp.json()["pbs"] for h in [p["label_id"]]]
    assert "too_long" not in all_label_ids_in_history
    assert "too_short" not in all_label_ids_in_history


def test_pbs_non_running_excluded(app_client):
    """Cycling activities (sport_type=200) must not be included in PB calculation."""
    client, token, tmp_path, _ = app_client
    db = _make_db(tmp_path)
    db._conn.executemany(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
        "VALUES (?, ?, ?, ?, ?)",
        [
            ("run_5k",   100, "2025-02-01", 5000.0, 1400.0),  # running → IN
            ("bike_5k",  200, "2025-02-02", 5000.0,  900.0),  # cycling → OUT (faster but wrong sport)
        ],
    )
    db._conn.commit()
    db.close()

    resp = client.get(f"/api/{USER_UUID}/pbs", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    pb_map = {p["distance"]: p for p in resp.json()["pbs"]}

    assert "5K" in pb_map
    # Cycling time (900s) must not be the PB — running time (1400s) should be
    assert pb_map["5K"]["pb_time_sec"] == 1400.0
    assert pb_map["5K"]["label_id"] == "run_5k"


def test_pbs_user_mismatch_403(app_client):
    """JWT sub != path user → 403."""
    client, _, tmp_path, private_pem = app_client
    _make_db(tmp_path).close()
    other_token = _token(private_pem, sub=OTHER_UUID)
    resp = client.get(f"/api/{USER_UUID}/pbs", headers=_auth(other_token))
    assert resp.status_code == 403


def test_pbs_empty_db(app_client):
    """No activities at all → empty pbs list, 200 OK."""
    client, token, tmp_path, _ = app_client
    _make_db(tmp_path).close()

    resp = client.get(f"/api/{USER_UUID}/pbs", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["pbs"] == []
    assert data["user_id"] == USER_UUID
