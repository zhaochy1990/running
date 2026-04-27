"""Tests for src/stride_server/routes/ability.py — 3 ability endpoints.

Covers:
  - Bearer enforcement (401 without token when public key is configured)
  - Valid token → 200 for /current, /history, /activities/{id}/ability
  - /activities/{nonexistent}/ability → 404
  - /history?days=90 returns oldest-first list, pivoted by date
  - /current fast path (reads pre-computed snapshot) + fallback path (computes live)
"""

from __future__ import annotations

import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from stride_core.db import Database
from stride_core.source import DataSource


# ---------------------------------------------------------------------------
# Fixtures — RSA key + FastAPI app wired to a tmp Database.
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


def _issue_token(private_pem: str, **overrides) -> str:
    now = int(time.time())
    claims = {
        "sub": "zhaochaoyi",
        "aud": "stride-client",
        "iss": "auth-service",
        "exp": now + 3600,
        "iat": now,
        "role": "user",
    }
    claims.update(overrides)
    return jwt.encode(claims, private_pem, algorithm="RS256")


def _reset_bearer_module(monkeypatch, public_pem: str | None = None):
    """Reset the module-level cache so env changes take effect."""
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
    """Minimal DataSource-ish stand-in — none of the ability endpoints call it."""
    def is_logged_in(self, user: str) -> bool:
        return True


@pytest.fixture
def tmp_db(tmp_path):
    """Build a throwaway SQLite DB with the schema already migrated."""
    db_path = tmp_path / "ability.db"
    db = Database(db_path)
    db.close()
    return db_path


@pytest.fixture
def client_and_db(tmp_db, monkeypatch):
    """Return (TestClient, db_path). Patches `get_db` so both the route layer
    and this test talk to the same on-disk DB.
    """
    import stride_server.routes.ability as ability_mod

    def _open_db(user: str):
        return Database(tmp_db)

    monkeypatch.setattr(ability_mod, "get_db", _open_db)

    # create_app() fails closed unless STRIDE_AUTH_PUBLIC_KEY_* is set or we're
    # in dev mode. Tests issue their own keys via _reset_bearer_module so dev
    # mode is the right escape hatch here.
    monkeypatch.setenv("STRIDE_ENV", "dev")

    from stride_server.app import create_app

    app = create_app(_StubSource())
    return TestClient(app), tmp_db


# ---------------------------------------------------------------------------
# Helpers — seed the DB with ability rows.
# ---------------------------------------------------------------------------

def _seed_snapshot(db_path, date: str, *, l4_composite=67.5,
                   training_s=10400, race_s=10088, best_case_s=9880,
                   l3_values=None):
    """Insert a full day's worth of rows into ability_snapshot."""
    l3_values = l3_values or {
        "aerobic": 80.0, "lt": 75.0, "vo2max": 72.0,
        "endurance": 78.0, "economy": 65.0, "recovery": 70.0,
    }
    db = Database(db_path)
    try:
        for dim, score in l3_values.items():
            db.upsert_ability_snapshot(date, "L3", dim, score,
                                       evidence_activity_ids=[f"evt-{dim}"])
        db.upsert_ability_snapshot(date, "L4", "composite", l4_composite)
        db.upsert_ability_snapshot(date, "L4", "marathon_training_s", training_s)
        db.upsert_ability_snapshot(date, "L4", "marathon_race_s", race_s)
        db.upsert_ability_snapshot(date, "L4", "marathon_best_case_s", best_case_s)
        db.upsert_ability_snapshot(date, "L2", "total", 80.0)
    finally:
        db.close()


def _seed_activity_ability(db_path, label_id: str):
    db = Database(db_path)
    try:
        db.upsert_activity_ability(
            label_id,
            l1_quality=82.5,
            l1_breakdown={"pace_adherence": 90.0, "hr_zone_adherence": 80.0,
                          "pace_stability": 85.0, "hr_decoupling": 70.0,
                          "cadence_stability": 88.0},
            contribution={"aerobic": 0.2, "lt": 0.0, "vo2max": 0.5,
                          "endurance": 0.0, "economy": 0.1, "recovery": 0.0},
        )
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Auth tests.
# ---------------------------------------------------------------------------

def test_current_requires_bearer(client_and_db, monkeypatch, rsa_keypair):
    _, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem=public_pem)
    client, _ = client_and_db

    resp = client.get("/api/zhaochaoyi/ability/current")
    assert resp.status_code == 401


def test_history_requires_bearer(client_and_db, monkeypatch, rsa_keypair):
    _, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem=public_pem)
    client, _ = client_and_db

    resp = client.get("/api/zhaochaoyi/ability/history")
    assert resp.status_code == 401


def test_activity_ability_requires_bearer(client_and_db, monkeypatch, rsa_keypair):
    _, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem=public_pem)
    client, _ = client_and_db

    resp = client.get("/api/zhaochaoyi/activities/foo/ability")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Happy-path tests with a valid Bearer token.
# ---------------------------------------------------------------------------

# NOTE: /current now always live-computes (dropped snapshot fast-path so the
# VO2max estimator breakdown — primary/secondary/floor — stays intact).
# The snapshot-pivot test was deleted along with that path.


def test_current_falls_back_to_live_compute_when_no_snapshot(
    client_and_db, monkeypatch, rsa_keypair
):
    """Fallback: no snapshot for today → compute_ability_snapshot runs on the fly.
    Empty DB → empty snapshot, but the shape is still present."""
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem=public_pem)
    client, _ = client_and_db

    import stride_server.routes.ability as ability_mod
    monkeypatch.setattr(ability_mod, "_today_iso", lambda: "2026-04-24")

    token = _issue_token(private_pem)
    resp = client.get(
        "/api/zhaochaoyi/ability/current",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source"] == "computed"
    assert body["date"] == "2026-04-24"
    # marathon_estimates dict always present (even when values are None)
    assert "marathon_estimates" in body
    for k in ("training_s", "race_s", "best_case_s"):
        assert k in body["marathon_estimates"]


def test_history_returns_list_oldest_first(
    client_and_db, monkeypatch, rsa_keypair
):
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem=public_pem)
    client, db_path = client_and_db

    # Seed three days — but the fetch_ability_history helper filters by
    # `date >= date('now', '-{days} days')` using SQLite's CURRENT_DATE, so
    # our inserted string dates must lie within that window. Use actual recent
    # dates (today-relative) to guarantee they match.
    from datetime import date, timedelta
    d0 = date.today()
    days_seeded = [d0 - timedelta(days=i) for i in (4, 2, 0)]
    for idx, d in enumerate(days_seeded):
        _seed_snapshot(
            db_path, d.isoformat(),
            l4_composite=60.0 + idx, race_s=10500 - idx * 50,
        )

    token = _issue_token(private_pem)
    resp = client.get(
        "/api/zhaochaoyi/ability/history?days=90",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert isinstance(body, list)
    assert len(body) == 3
    # Oldest first
    assert body[0]["date"] == days_seeded[0].isoformat()
    assert body[-1]["date"] == days_seeded[-1].isoformat()
    # Every entry carries the expected keys
    for row in body:
        assert "l4_composite" in row
        assert "l4_marathon_race_s" in row
        assert "l3" in row
        for k in ("aerobic", "lt", "vo2max", "endurance", "economy", "recovery"):
            assert k in row["l3"]


def test_history_empty_when_no_rows(
    client_and_db, monkeypatch, rsa_keypair
):
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem=public_pem)
    client, _ = client_and_db

    token = _issue_token(private_pem)
    resp = client.get(
        "/api/zhaochaoyi/ability/history?days=30",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json() == []


def test_activity_ability_404_when_missing(
    client_and_db, monkeypatch, rsa_keypair
):
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem=public_pem)
    client, _ = client_and_db

    token = _issue_token(private_pem)
    resp = client.get(
        "/api/zhaochaoyi/activities/does-not-exist/ability",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 404


def test_activity_ability_returns_row_when_seeded(
    client_and_db, monkeypatch, rsa_keypair
):
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem=public_pem)
    client, db_path = client_and_db

    # Seed an activity row to satisfy the FK on activity_ability.
    db = Database(db_path)
    try:
        db._conn.execute(
            "INSERT INTO activities (label_id, sport_type, date) VALUES (?, ?, ?)",
            ("lbl-1", 100, "2026-04-24T08:00:00"),
        )
        db._conn.commit()
    finally:
        db.close()
    _seed_activity_ability(db_path, "lbl-1")

    token = _issue_token(private_pem)
    resp = client.get(
        "/api/zhaochaoyi/activities/lbl-1/ability",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["label_id"] == "lbl-1"
    assert body["l1_quality"] == 82.5
    assert body["l1_breakdown"]["pace_adherence"] == 90.0
    assert body["contribution"]["vo2max"] == 0.5
    assert body["computed_at"]


def test_weights_endpoint(client_and_db, monkeypatch, rsa_keypair):
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem=public_pem)
    client, _ = client_and_db

    token = _issue_token(private_pem)
    resp = client.get(
        "/api/zhaochaoyi/ability/weights",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "l4_weights" in body
    # Weights sum to 1.0 (sub-2:50 weighting).
    assert abs(sum(body["l4_weights"].values()) - 1.0) < 1e-6
