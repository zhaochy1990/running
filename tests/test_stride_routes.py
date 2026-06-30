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

from stride_storage.sqlite.database import Database
from stride_storage.sqlite.calibration_connector import SQLiteRunningCalibrationRepository


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
        # Use the canonical zone names + zone_kinds emitted by
        # running_calibration/zones.py: 6 zones per kind, names
        # recovery/easy/marathon/threshold/interval/repetition; kinds
        # 'heart_rate' and 'pace'. Earlier test data used 'hr' + Z1..Z5
        # which let a route filter mismatch (looking for 'hr', not
        # 'heart_rate') ship in the first prod-data run.
        zones = [
            (snap_id, "heart_rate", "recovery",   None,  140.0, None, None, "medium"),
            (snap_id, "heart_rate", "easy",       140.0, 154.0, None, None, "medium"),
            (snap_id, "heart_rate", "marathon",   154.0, 165.0, None, None, "medium"),
            (snap_id, "heart_rate", "threshold",  165.0, 175.0, None, None, "medium"),
            (snap_id, "heart_rate", "interval",   175.0, 188.0, None, None, "medium"),
            (snap_id, "heart_rate", "repetition", 188.0, None,  None, None, "medium"),
            (snap_id, "pace", "recovery",   None, None, None, 2.79, "medium"),
            (snap_id, "pace", "easy",       None, None, 2.79, 3.35, "medium"),
            (snap_id, "pace", "marathon",   None, None, 3.35, 3.91, "medium"),
            (snap_id, "pace", "threshold",  None, None, 3.91, 4.51, "medium"),
            (snap_id, "pace", "interval",   None, None, 4.51, 4.79, "medium"),
            (snap_id, "pace", "repetition", None, None, 4.79, None, "medium"),
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
    assert len(body["pace_zones"]) == 6
    assert len(body["hr_zones"]) == 6
    # Physiological ordering: recovery → easy → marathon → threshold → interval → repetition.
    assert [z["name"] for z in body["hr_zones"]] == [
        "recovery", "easy", "marathon", "threshold", "interval", "repetition",
    ]
    assert [z["name"] for z in body["pace_zones"]] == [
        "recovery", "easy", "marathon", "threshold", "interval", "repetition",
    ]
    # Display labels are 配速N区 / 心率N区 indexed by physiological order
    # (1=recovery .. 6=repetition) so they line up with watch-zone numbering.
    assert body["hr_zones"][0]["label"] == "心率1区"
    assert body["pace_zones"][0]["label"] == "配速1区"
    assert body["hr_zones"][3]["label"] == "心率4区"
    assert body["pace_zones"][5]["label"] == "配速6区"
    # recovery zone: HR upper_bpm = 140, lower_bpm = None (open lower)
    assert body["hr_zones"][0]["lower_bpm"] is None
    assert body["hr_zones"][0]["upper_bpm"] == 140
    # easy zone: HR 140–154
    assert body["hr_zones"][1]["lower_bpm"] == 140
    assert body["hr_zones"][1]["upper_bpm"] == 154
    # Pace edges format as "M:SS"
    assert ":" in body["pace_zones"][1]["lower_pace"]
    assert ":" in body["pace_zones"][1]["upper_pace"]


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


def test_stride_zones_bootstraps_missing_calibration_schema(
    rsa_keypair, monkeypatch, tmp_path
):
    """User DB has never had SQLiteRunningCalibrationRepository instantiated.

    In production this happens for any user whose DB predates the calibration
    migration — the running_calibration_snapshot / running_calibration_zone
    tables only get bootstrapped lazily by the connector. The route must
    create them on first hit and return the empty-state shape, not 500 with
    'no such table'.
    """
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem)

    # Open a fresh DB WITHOUT calling SQLiteRunningCalibrationRepository.
    raw_db_path = tmp_path / "no_calibration_schema.db"
    Database(raw_db_path).close()  # only the main Database schema, no calibration tables

    import stride_server.routes.stride as stride_mod
    monkeypatch.setattr(stride_mod, "get_db", lambda user: Database(raw_db_path))

    client = _build_client(public_pem)
    token = _issue_token(private_pem)
    resp = client.get(
        f"/api/{USER_ID}/stride/zones",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"threshold": None, "pace_zones": [], "hr_zones": []}


def _seed_training_load(db_path: Path):
    """Insert 5 days of daily_training_load."""
    db = Database(db_path)
    try:
        rows = [
            ("2026-05-17", 1, None, 60.0, 70.0, 70.0, 0.0, 1.00, "go",  '["ok"]'),
            ("2026-05-18", 1, None, 75.0, 72.0, 70.5, -1.5, 1.02, "go",  '["ok"]'),
            ("2026-05-19", 1, None, 80.0, 75.0, 71.5, -3.5, 1.05, "caution", '["high_load"]'),
            ("2026-05-20", 1, None, 70.0, 76.0, 72.5, -3.5, 1.05, "go",  '["ok"]'),
            ("2026-05-21", 1, None, 75.2, 78.0, 72.0, -6.0, 1.08, "go",  '["ok"]'),
        ]
        db._conn.executemany(
            """INSERT INTO daily_training_load
               (date, algorithm_version, calibration_id, training_dose,
                acute_load, chronic_load, form, load_ratio,
                readiness_gate, readiness_reasons_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
        db._conn.commit()
    finally:
        db.close()


def test_stride_training_load_happy_path(rsa_keypair, monkeypatch, seeded_db):
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem)
    _seed_training_load(seeded_db)

    client = _build_client(public_pem)
    token = _issue_token(private_pem)
    resp = client.get(
        f"/api/{USER_ID}/stride/training-load?days=30",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["current"]["date"] == "2026-05-21"
    assert body["current"]["acute_load"] == 78.0
    assert body["current"]["chronic_load"] == 72.0
    assert body["current"]["form"] == -6.0
    assert body["current"]["load_ratio"] == 1.08
    assert body["current"]["readiness_gate"] == "go"
    assert body["current"]["readiness_reasons"] == ["ok"]
    assert len(body["series"]) == 5
    # series oldest-first
    assert body["series"][0]["date"] == "2026-05-17"
    assert body["series"][-1]["date"] == "2026-05-21"


def test_stride_training_load_no_data(rsa_keypair, monkeypatch, seeded_db):
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem)

    client = _build_client(public_pem)
    token = _issue_token(private_pem)
    resp = client.get(
        f"/api/{USER_ID}/stride/training-load?days=30",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"current": None, "series": []}


def test_stride_training_load_validates_days(rsa_keypair, monkeypatch, seeded_db):
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem)

    client = _build_client(public_pem)
    token = _issue_token(private_pem)
    for bad in (0, 6, 400, -1):
        resp = client.get(
            f"/api/{USER_ID}/stride/training-load?days={bad}",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 422, f"days={bad} should 422"
