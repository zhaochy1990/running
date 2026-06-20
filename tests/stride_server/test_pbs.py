"""Tests for GET /api/{user}/pbs — personal bests auto-detection."""

from __future__ import annotations

import json
import time
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
OTHER_UUID = "b1b2c3d4-e5f6-4aaa-89ab-123456789012"
SEGMENT_FIXTURE = (
    Path(__file__).parents[1]
    / "fixtures"
    / "segment_pb"
    / "activity_477783793625760045.json"
)


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


def _seed_segment_fixture(db) -> dict:
    """Insert the 13.36 km segment-PB fixture activity + timeseries. Returns the
    activity dict. The run is long enough to contain 1K/3K/5K best efforts."""
    data = json.loads(SEGMENT_FIXTURE.read_text())
    activity = data["activity"]
    db._conn.execute(
        """INSERT INTO activities
           (label_id, sport_type, date, distance_m, duration_s, avg_hr,
            max_hr, train_kind, train_type, pauses, provider)
           VALUES (:label_id, :sport_type, :date, :distance_m, :duration_s,
                   :avg_hr, :max_hr, :train_kind, :train_type, :pauses,
                   :provider)""",
        activity,
    )
    for point in data["timeseries"]:
        db._conn.execute(
            "INSERT INTO timeseries (label_id, timestamp, distance) VALUES (?, ?, ?)",
            (activity["label_id"], point["timestamp"], point["distance"]),
        )
    db._conn.commit()
    return activity


def test_pbs_uses_fastest_continuous_segment_when_activity_is_longer(app_client):
    """A 13.36 km workout with an embedded 5K in ~19:30 should count as
    the 5K best effort. This keeps /pbs aligned with the VO2max PB channel.
    """
    client, token, tmp_path, _ = app_client
    db = _make_db(tmp_path)
    activity = _seed_segment_fixture(db)
    db.close()

    resp = client.get(f"/api/{USER_UUID}/pbs", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    pb_map = {p["distance"]: p for p in resp.json()["pbs"]}

    assert "5K" in pb_map
    assert pb_map["5K"]["pb_time_sec"] == pytest.approx(1170, abs=5)
    assert pb_map["5K"]["label_id"] == activity["label_id"]
    assert pb_map["5K"]["achieved_at"] == "2026-05-27"
    assert pb_map["5K"]["history"][-1]["best_so_far_sec"] == pytest.approx(1170, abs=5)


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


def test_pbs_includes_1k_and_3k_segments(app_client):
    """The /pbs route uses the wide display set, so a long run yields 1K and 3K
    best efforts ordered before 5K, with strictly increasing times."""
    client, token, tmp_path, _ = app_client
    db = _make_db(tmp_path)
    _seed_segment_fixture(db)
    db.close()

    resp = client.get(f"/api/{USER_UUID}/pbs", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    pbs = resp.json()["pbs"]
    pb_map = {p["distance"]: p for p in pbs}

    assert "1K" in pb_map
    assert "3K" in pb_map
    assert "5K" in pb_map
    # Absolute fastest-segment durations must increase with distance.
    assert pb_map["1K"]["pb_time_sec"] < pb_map["3K"]["pb_time_sec"]
    assert pb_map["3K"]["pb_time_sec"] < pb_map["5K"]["pb_time_sec"]
    # Response order follows DISTANCE_ORDER: 1K, 3K come before 5K.
    order = [p["distance"] for p in pbs]
    assert order.index("1K") < order.index("3K") < order.index("5K")


def test_detect_personal_bests_default_excludes_1k_3k(app_client):
    """The default (narrow) detector must NOT emit 1K/3K — this is what the
    ability/VDOT model and coach tool consume. The wide set opts in explicitly."""
    from stride_core.pb_records import (
        CANONICAL_RACE_DISTANCES,
        PB_DISPLAY_DISTANCES,
        detect_personal_bests,
    )

    _, _, tmp_path, _ = app_client
    db = _make_db(tmp_path)
    _seed_segment_fixture(db)

    narrow = detect_personal_bests(db)  # default
    assert "1K" not in narrow
    assert "3K" not in narrow
    assert set(narrow).issubset({"5K", "10K", "HM", "FM"})

    wide = detect_personal_bests(db, distances=PB_DISPLAY_DISTANCES)
    assert "1K" in wide
    assert "3K" in wide
    db.close()

    # Guard: the display set is the canonical four plus 1K/3K.
    assert set(PB_DISPLAY_DISTANCES) == set(CANONICAL_RACE_DISTANCES) | {"1K", "3K"}
