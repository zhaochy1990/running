"""Tests for the `intensity_summary` field on GET /api/{user}/weeks/{folder}.

Exercises the time-fraction proxy used to translate HR zone duration into
run-km per band (low = Z1+Z2, mid = Z3, high = Z4+Z5).
"""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient


USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
WEEK = "2026-04-20_04-26(W0)"


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

    (tmp_path / USER_UUID / "logs" / WEEK).mkdir(parents=True, exist_ok=True)

    from stride_server.bearer import require_bearer, verify_path_user
    from stride_server.routes.weeks import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer), Depends(verify_path_user)])

    token = _make_token(private_pem)
    client = TestClient(app, raise_server_exceptions=False)
    return client, token, tmp_path


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _seed_run(
    db,
    label_id: str,
    *,
    date: str,
    distance_m: float,
    duration_s: int,
    sport_type: int = 100,
    zones: list[tuple[int, int]] | None = None,
):
    """Insert a minimal run + its HR zones. Avoids the heavyweight
    `upsert_activity` path so each row only needs the columns we touch."""
    db._conn.execute(
        """INSERT INTO activities
           (label_id, sport_type, sport_name, date, distance_m, duration_s)
           VALUES (?, ?, 'Run', ?, ?, ?)""",
        (label_id, sport_type, date, distance_m, duration_s),
    )
    for zi, secs in zones or []:
        db._conn.execute(
            """INSERT INTO zones
               (label_id, zone_type, zone_index, range_min, range_max,
                range_unit, duration_s, percent)
               VALUES (?, 'heartRate', ?, NULL, NULL, 'bpm', ?, NULL)""",
            (label_id, zi, secs),
        )
    db._conn.commit()


def test_intensity_summary_aggregates_zones_into_low_mid_high(app_client):
    client, token, tmp_path = app_client
    from stride_core.db import Database

    db = Database(tmp_path / USER_UUID / "coros.db")
    # 40 km / 4h split: 60% in Z1+Z2, 20% in Z3, 20% in Z4+Z5.
    _seed_run(
        db,
        "act-1",
        date="2026-04-20T07:00:00",
        distance_m=40000.0,
        duration_s=14400,
        zones=[(1, 4320), (2, 4320), (3, 2880), (4, 1440), (5, 1440)],
    )
    db.close()

    resp = client.get(f"/api/{USER_UUID}/weeks/{WEEK}", headers=_auth(token))
    assert resp.status_code == 200
    s = resp.json()["intensity_summary"]
    assert s["has_zone_data"] is True
    assert s["total_run_km"] == 40000.0
    # 60% × 40000 = 24000, 20% × 40000 = 8000, 20% × 40000 = 8000.
    assert s["low_km"] == pytest.approx(24000.0, abs=0.5)
    assert s["mid_km"] == pytest.approx(8000.0, abs=0.5)
    assert s["high_km"] == pytest.approx(8000.0, abs=0.5)


def test_intensity_summary_excludes_non_run_sport_types(app_client):
    client, token, tmp_path = app_client
    from stride_core.db import Database

    db = Database(tmp_path / USER_UUID / "coros.db")
    # Strength session (sport_type=4) should NOT count toward run mileage and
    # its zones should be ignored even if present.
    _seed_run(
        db,
        "act-strength",
        date="2026-04-21T07:00:00",
        distance_m=999.0,
        duration_s=3600,
        sport_type=4,
        zones=[(2, 3600)],
    )
    _seed_run(
        db,
        "act-run",
        date="2026-04-20T07:00:00",
        distance_m=10000.0,
        duration_s=3600,
        zones=[(1, 1800), (2, 1800)],
    )
    db.close()

    resp = client.get(f"/api/{USER_UUID}/weeks/{WEEK}", headers=_auth(token))
    s = resp.json()["intensity_summary"]
    assert s["total_run_km"] == 10000.0  # strength's 999 m excluded
    assert s["low_km"] == pytest.approx(10000.0, abs=0.5)
    assert s["high_km"] == pytest.approx(0.0, abs=0.5)


def test_intensity_summary_no_zone_data_returns_run_km_only(app_client):
    client, token, tmp_path = app_client
    from stride_core.db import Database

    db = Database(tmp_path / USER_UUID / "coros.db")
    _seed_run(
        db,
        "act-1",
        date="2026-04-22T07:00:00",
        distance_m=8000.0,
        duration_s=2700,
        zones=[],
    )
    db.close()

    resp = client.get(f"/api/{USER_UUID}/weeks/{WEEK}", headers=_auth(token))
    s = resp.json()["intensity_summary"]
    assert s["has_zone_data"] is False
    assert s["total_run_km"] == 8000.0
    assert s["low_km"] is None
    assert s["mid_km"] is None
    assert s["high_km"] is None


def test_intensity_summary_empty_week_returns_zero(app_client):
    client, token, _ = app_client
    resp = client.get(f"/api/{USER_UUID}/weeks/{WEEK}", headers=_auth(token))
    s = resp.json()["intensity_summary"]
    assert s["total_run_km"] == 0
    assert s["has_zone_data"] is False
    assert s["low_km"] is None
