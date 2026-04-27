"""Tests for stride_core.status_report and /api/users/me/status endpoint."""

from __future__ import annotations

import json
import time
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI, Depends
from fastapi.testclient import TestClient

from stride_core.db import Database
from stride_core.status_report import generate_starter_status

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"


# --- Generator tests ---

def test_empty_user_dir_does_not_crash(tmp_path):
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()

    md = generate_starter_status(USER_UUID, data_root=tmp_path)

    assert "Profile not set" in md
    assert "No activities" in md
    assert (user_dir / "status.md").exists()


def test_empty_user_dir_no_subdir_does_not_crash(tmp_path):
    # user_dir doesn't even exist yet
    md = generate_starter_status(USER_UUID, data_root=tmp_path)
    assert isinstance(md, str)
    assert "Profile not set" in md


def test_profile_section_rendered(tmp_path):
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()
    profile = {
        "display_name": "Test Runner",
        "target_race": "上海马拉松 2026",
        "target_distance": "FM",
        "target_race_date": "2026-10-18",
        "target_time": "2:50:00",
        "weekly_mileage_km": 60,
    }
    (user_dir / "profile.json").write_text(json.dumps(profile), encoding="utf-8")

    md = generate_starter_status(USER_UUID, data_root=tmp_path)

    assert "Test Runner" in md
    assert "FM" in md
    assert "2026-10-18" in md
    assert "2:50:00" in md
    assert "60" in md


def test_activity_section_rendered(tmp_path):
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()

    db = Database(db_path=user_dir / "coros.db")
    from stride_core.models import ActivityDetail
    # Insert a recent activity directly via SQL to avoid needing full ActivityDetail
    db._conn.execute(
        """INSERT INTO activities
           (label_id, name, sport_type, sport_name, date,
            distance_m, duration_s, avg_pace_s_km, avg_hr, synced_at)
           VALUES (?, ?, ?, ?, date('now', '-3 days'), ?, ?, ?, ?, datetime('now'))""",
        # distance_m column actually stores km (coros_sync legacy naming);
        # 10.5 km in 1h matches the avg_pace_s_km=342.86 (5:43/km).
        ("test-001", "Morning Run", 100, "Running", 10.5, 3600, 342.86, 148),
    )
    db._conn.commit()
    db.close()

    md = generate_starter_status(USER_UUID, data_root=tmp_path)

    assert "Last 14 Days" in md
    assert "1" in md  # 1 activity
    assert "10.5" in md  # ~10.5 km


def test_fitness_section_rendered(tmp_path):
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()

    db = Database(db_path=user_dir / "coros.db")
    db._conn.execute(
        """INSERT OR REPLACE INTO dashboard
           (id, running_level, aerobic_score, lactate_threshold_score,
            anaerobic_endurance_score, anaerobic_capacity_score,
            rhr, threshold_hr, threshold_pace_s_km, recovery_pct,
            avg_sleep_hrv, hrv_normal_low, hrv_normal_high,
            weekly_distance_m, weekly_duration_s)
           VALUES (1, 72.5, 68.0, 65.0, 55.0, 50.0,
                   48, 165, 280.0, 85.0,
                   55.0, 48.0, 62.0,
                   50000, 18000)"""
    )
    db._conn.commit()
    db.close()

    md = generate_starter_status(USER_UUID, data_root=tmp_path)

    assert "Current Fitness" in md
    assert "72" in md  # running_level


def test_fatigue_section_rendered(tmp_path):
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()

    db = Database(db_path=user_dir / "coros.db")
    db._conn.execute(
        """INSERT OR REPLACE INTO daily_health
           (date, ati, cti, rhr, distance_m, duration_s,
            training_load_ratio, training_load_state, fatigue)
           VALUES ('2026-04-27', 45.0, 50.0, 50, 10000, 3600,
                   0.9, 'Optimal', 42.0)"""
    )
    db._conn.commit()
    db.close()

    md = generate_starter_status(USER_UUID, data_root=tmp_path)

    assert "Recent Fatigue" in md
    assert "42" in md
    assert "Optimal" in md


def test_status_md_written(tmp_path):
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()

    generate_starter_status(USER_UUID, data_root=tmp_path)

    assert (user_dir / "status.md").exists()


def test_status_md_overwritten_on_second_call(tmp_path):
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()

    (user_dir / "profile.json").write_text(
        json.dumps({"display_name": "First"}), encoding="utf-8"
    )
    generate_starter_status(USER_UUID, data_root=tmp_path)

    (user_dir / "profile.json").write_text(
        json.dumps({"display_name": "Second"}), encoding="utf-8"
    )
    md = generate_starter_status(USER_UUID, data_root=tmp_path)

    assert "Second" in md
    content = (user_dir / "status.md").read_text(encoding="utf-8")
    assert "Second" in content
    assert "First" not in content


# --- Route tests ---

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


def _make_token(private_pem: str, sub: str = USER_UUID) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "iss": "auth-service", "exp": now + 3600, "iat": now, "role": "user"},
        private_pem,
        algorithm="RS256",
    )


@pytest.fixture
def status_client(tmp_path, monkeypatch, rsa_keypair):
    private_pem, public_pem = rsa_keypair

    import stride_server.bearer as bearer
    monkeypatch.setattr(bearer, "_cached_public_key", public_pem)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for key in ("STRIDE_AUTH_PUBLIC_KEY_PEM", "STRIDE_AUTH_PUBLIC_KEY_PATH",
                "STRIDE_AUTH_ISSUER", "STRIDE_AUTH_AUDIENCE"):
        monkeypatch.delenv(key, raising=False)

    import stride_server.routes.profile as profile_mod
    monkeypatch.setattr(profile_mod, "USER_DATA_DIR", tmp_path)

    from stride_server.bearer import require_bearer
    from stride_server.routes.profile import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer)])

    token = _make_token(private_pem)
    client = TestClient(app, raise_server_exceptions=False)
    return client, token, tmp_path


def test_status_route_404_when_file_missing(status_client):
    client, token, _ = status_client
    resp = client.get("/api/users/me/status", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 404


def test_status_route_returns_markdown_when_present(status_client):
    client, token, tmp_path = status_client
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)
    (user_dir / "status.md").write_text("# Hello\n\nSome report.", encoding="utf-8")

    resp = client.get("/api/users/me/status", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    data = resp.json()
    assert "markdown" in data
    assert "Hello" in data["markdown"]


def test_status_route_no_auth_returns_401(status_client):
    client, _, _ = status_client
    resp = client.get("/api/users/me/status")
    assert resp.status_code == 401
