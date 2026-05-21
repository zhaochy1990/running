"""Tests for src/stride_server/routes/stride.py — STRIDE algorithm endpoints.

Covers /api/{user}/stride/zones and /api/{user}/stride/training-load.

Fixture adjustments vs the original plan spec:
- _build_client uses create_app (not build_app, which does not exist) with a
  _StubSource, matching the pattern in test_ability_api.py.
- seeded_db patches stride_server.routes.stride.get_db rather than relying on
  STRIDE_USER_DATA_DIR (which db.py does not read), so both the test helper
  _seed_calibration and the route handler open the same tmp-path Database.
"""

from __future__ import annotations

import time
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from stride_core.db import Database
from stride_core.running_calibration.sqlite_connector import SQLiteRunningCalibrationRepository


USER_ID = "00000000-0000-4000-8000-000000000001"


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


def _issue_token(private_pem: str, **overrides) -> str:
    now = int(time.time())
    claims = {
        "sub": USER_ID,
        "aud": "stride-client",
        "iss": "auth-service",
        "exp": now + 3600,
        "iat": now,
        "role": "user",
    }
    claims.update(overrides)
    return jwt.encode(claims, private_pem, algorithm="RS256")


def _reset_bearer_module(monkeypatch, public_pem: str | None = None):
    import stride_server.bearer as bearer
    monkeypatch.setattr(bearer, "_cached_public_key", None)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for k in (
        "STRIDE_AUTH_PUBLIC_KEY_PEM",
        "STRIDE_AUTH_PUBLIC_KEY_PATH",
        "STRIDE_AUTH_ISSUER",
        "STRIDE_AUTH_AUDIENCE",
    ):
        monkeypatch.delenv(k, raising=False)
    if public_pem is not None:
        monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)


class _StubSource:
    """Minimal DataSource-ish stand-in — stride endpoints don't call it."""

    name = "stub"

    @property
    def info(self):
        from stride_core.source import ProviderInfo
        return ProviderInfo(name="stub", display_name="Stub", regions=(), capabilities=frozenset())

    def is_logged_in(self, user: str) -> bool:
        return True


@pytest.fixture
def tmp_db_path(tmp_path) -> Path:
    """Create an empty, schema-migrated DB at a known tmp path.

    Bootstraps calibration tables via the canonical connector so the
    schema matches running_calibration/sqlite_connector.py exactly.
    """
    db_path = tmp_path / "stride_test.db"
    db = Database(db_path)
    SQLiteRunningCalibrationRepository(db)  # calls ensure_schema() in __init__
    db.close()
    return db_path


@pytest.fixture
def seeded_db(tmp_db_path, monkeypatch) -> Path:
    """Patch stride.get_db so the route and test helpers share the same DB."""
    import stride_server.routes.stride as stride_mod

    def _open_db(user: str):
        return Database(tmp_db_path)

    monkeypatch.setattr(stride_mod, "get_db", _open_db)
    return tmp_db_path


def _seed_calibration(db_path: Path):
    """Insert a fully-populated calibration + zones."""
    db = Database(db_path)
    try:
        cur = db._conn.execute(
            """INSERT INTO running_calibration_snapshot
               (as_of_date, algorithm_version, threshold_hr, threshold_speed_mps,
                threshold_hr_confidence, threshold_speed_confidence,
                rhr_baseline, observed_max_hr, hrmax_estimate, hrmax_confidence)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("2026-05-15", 1, 175.0, 4.65, "medium", "medium", 47.0, 188.0, 188.0, "medium"),
        )
        snap_id = cur.lastrowid
        zones = [
            (snap_id, "hr", "Z1", 105.0, 140.0, None, None, "medium"),
            (snap_id, "hr", "Z2", 140.0, 154.0, None, None, "medium"),
            (snap_id, "hr", "Z3", 154.0, 165.0, None, None, "medium"),
            (snap_id, "hr", "Z4", 165.0, 175.0, None, None, "medium"),
            (snap_id, "hr", "Z5", 175.0, 188.0, None, None, "medium"),
            (snap_id, "pace", "Z1", None, None, 2.79, 3.35, "medium"),
            (snap_id, "pace", "Z2", None, None, 3.35, 3.91, "medium"),
            (snap_id, "pace", "Z3", None, None, 3.91, 4.51, "medium"),
            (snap_id, "pace", "Z4", None, None, 4.51, 4.79, "medium"),
            (snap_id, "pace", "Z5", None, None, 4.79, 5.16, "medium"),
        ]
        db._conn.executemany(
            """INSERT INTO running_calibration_zone
               (snapshot_id, zone_kind, name, min_value, max_value, min_speed_mps, max_speed_mps, confidence)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            zones,
        )
        db._conn.commit()
    finally:
        db.close()


def _build_client(public_pem: str) -> TestClient:
    from stride_server.app import create_app
    from stride_server.config.models import AuthConfig, ServerConfig

    cfg = ServerConfig.default(env="prod").with_updates(
        auth=AuthConfig(public_key_pem=public_pem, audience="stride-client")
    )
    return TestClient(create_app(_StubSource(), config=cfg))


def test_stride_zones_happy_path(rsa_keypair, monkeypatch, seeded_db):
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem)
    _seed_calibration(seeded_db)

    client = _build_client(public_pem)
    token = _issue_token(private_pem)
    resp = client.get(
        f"/api/{USER_ID}/stride/zones",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["threshold"]["speed_mps"] == pytest.approx(4.65)
    assert body["threshold"]["hr_bpm"] == pytest.approx(175.0)
    assert body["threshold"]["pace_per_km_sec"] == pytest.approx(1000 / 4.65, rel=1e-3)
    assert body["threshold"]["as_of_date"] == "2026-05-15"
    assert len(body["pace_zones"]) == 5
    assert len(body["hr_zones"]) == 5
    assert body["hr_zones"][0]["name"] == "Z1"
    assert body["hr_zones"][0]["lower_bpm"] == 105
    assert body["hr_zones"][0]["upper_bpm"] == 140
    assert body["pace_zones"][0]["name"] == "Z1"
    assert ":" in body["pace_zones"][0]["lower_pace"]
    assert ":" in body["pace_zones"][0]["upper_pace"]


def test_stride_zones_no_calibration(rsa_keypair, monkeypatch, seeded_db):
    """User exists but has no calibration row → null threshold + empty zones."""
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem)
    # Note: no _seed_calibration() call — DB has the schema but no rows

    client = _build_client(public_pem)
    token = _issue_token(private_pem)
    resp = client.get(
        f"/api/{USER_ID}/stride/zones",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"threshold": None, "pace_zones": [], "hr_zones": []}


def test_stride_zones_unauthenticated(rsa_keypair, monkeypatch, seeded_db):
    """No Bearer token → 401."""
    _, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem)

    client = _build_client(public_pem)
    resp = client.get(f"/api/{USER_ID}/stride/zones")
    assert resp.status_code == 401
