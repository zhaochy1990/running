"""Tests for GET /api/{user}/race-predictions and /race-predictions/history.

US-006 — backend race-prediction endpoints.

Covers:
  1. Normal user + ability_snapshot has data → 200 with 4 distances + vo2max
  2. No ability data → 404
  3. training-goal type=race + target_finish_time → target_gap returned
  4. training-goal type != race → target_gap = null
  5. history?days=30 → series length matches seeded rows
  6. user mismatch → 403
"""

from __future__ import annotations

import json
import time
from datetime import date, timedelta

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from stride_core.ability import ABILITY_MODEL_VERSION
from stride_core.db import Database


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

USER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
OTHER = "ffffffff-0000-4111-8222-333333333333"


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


def _token(private_pem: str, sub: str = USER) -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "sub": sub,
            "iss": "auth-service",
            "exp": now + 3600,
            "iat": now,
            "role": "user",
        },
        private_pem,
        algorithm="RS256",
    )


def _reset_bearer(monkeypatch, public_pem: str):
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
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)


class _StubSource:
    name = "stub"

    @property
    def info(self):
        from stride_core.source import ProviderInfo
        return ProviderInfo(name="stub", display_name="Stub", regions=(), capabilities=frozenset())

    def is_logged_in(self, user: str) -> bool:
        return True


@pytest.fixture
def setup(tmp_path, monkeypatch, rsa_keypair):
    """Return (TestClient, db_path, private_pem) with bearer + db wired."""
    private_pem, public_pem = rsa_keypair
    _reset_bearer(monkeypatch, public_pem)
    monkeypatch.setenv("STRIDE_ENV", "dev")

    db_path = tmp_path / "pred.db"
    db = Database(db_path)
    db.close()

    import stride_server.routes.predictions as pred_mod
    import stride_core.db as core_db_mod
    import stride_server.content_store as cs_mod

    monkeypatch.setattr(pred_mod, "get_db", lambda user: Database(db_path))
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(cs_mod, "read_json", lambda path: None)

    from stride_server.app import create_app
    app = create_app(_StubSource())
    client = TestClient(app)

    return client, db_path, private_pem, tmp_path, monkeypatch


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _seed_snapshot(db_path, date_str: str, vo2max_score: float = 70.0):
    """Insert a minimal ability_snapshot row (meta version + L3 vo2max)."""
    db = Database(db_path)
    try:
        db.upsert_ability_snapshot(date_str, "meta", "model_version",
                                   float(ABILITY_MODEL_VERSION))
        db.upsert_ability_snapshot(date_str, "L3", "vo2max", vo2max_score)
    finally:
        db.close()


def _write_training_goal(tmp_path, user: str, goal: dict):
    user_dir = tmp_path / user
    user_dir.mkdir(parents=True, exist_ok=True)
    store = {"current": goal, "history": []}
    (user_dir / "training_goal.json").write_text(
        json.dumps(store), encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# Test 1: normal user with ability_snapshot → 200 with 4 distances + vo2max
# ---------------------------------------------------------------------------

def test_normal_user_returns_predictions(setup):
    client, db_path, private_pem, tmp_path, _ = setup

    today = date.today().isoformat()
    _seed_snapshot(db_path, today, vo2max_score=72.0)

    resp = client.get(
        f"/api/{USER}/race-predictions",
        headers={"Authorization": f"Bearer {_token(private_pem)}"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["user_id"] == USER
    assert body["computed_at"] == today
    assert isinstance(body["vo2max"], float)
    assert body["vo2max_trend"] in ("up", "down", "flat")

    for dist in ("5K", "10K", "HM", "FM"):
        assert dist in body["distances"], f"Missing distance {dist}"
        d = body["distances"][dist]
        assert d["predicted_time_sec"] > 0, f"{dist} time must be positive"
        assert d["predicted_pace_sec_per_km"] > 0, f"{dist} pace must be positive"

    # 5K should be faster (fewer seconds) than 10K which is faster than HM which is faster than FM
    assert body["distances"]["5K"]["predicted_time_sec"] < body["distances"]["10K"]["predicted_time_sec"]
    assert body["distances"]["10K"]["predicted_time_sec"] < body["distances"]["HM"]["predicted_time_sec"]
    assert body["distances"]["HM"]["predicted_time_sec"] < body["distances"]["FM"]["predicted_time_sec"]


# ---------------------------------------------------------------------------
# Test 2: no ability data → 404
# ---------------------------------------------------------------------------

def test_no_ability_data_returns_404(setup):
    client, db_path, private_pem, tmp_path, _ = setup
    # No snapshot seeded.

    resp = client.get(
        f"/api/{USER}/race-predictions",
        headers={"Authorization": f"Bearer {_token(private_pem)}"},
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Test 3: training-goal type=race with target → target_gap returned
# ---------------------------------------------------------------------------

def test_target_gap_returned_when_race_goal(setup):
    client, db_path, private_pem, tmp_path, monkeypatch = setup

    today = date.today().isoformat()
    _seed_snapshot(db_path, today, vo2max_score=68.0)

    # Write a training goal for FM with a target finish time.
    goal = {
        "type": "race",
        "race_distance": "FM",
        "target_finish_time": "3:30:00",  # 12600 s
        "race_date": (date.today() + timedelta(days=90)).isoformat(),
        "weekly_training_days": 5,
        "available_time_slots": ["morning"],
        "strength_willingness": "yes",
    }

    # Patch content_store.read_json so the route reads our local goal.
    import stride_server.routes.predictions as pred_mod
    import stride_server.content_store as cs_mod

    def _mock_read_json(path):
        if path == f"{USER}/training_goal.json":
            return ({"current": goal, "history": []}, "file")
        return None

    monkeypatch.setattr(pred_mod, "read_json", _mock_read_json)

    resp = client.get(
        f"/api/{USER}/race-predictions",
        headers={"Authorization": f"Bearer {_token(private_pem)}"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    tg = body["target_gap"]
    assert tg is not None
    assert tg["distance"] == "FM"
    assert tg["target_time_sec"] == 12600
    assert tg["current_time_sec"] > 0
    assert "gap_sec" in tg
    assert isinstance(tg["on_track"], bool)


# ---------------------------------------------------------------------------
# Test 4: training-goal type != race → target_gap = null
# ---------------------------------------------------------------------------

def test_target_gap_null_when_non_race_goal(setup):
    client, db_path, private_pem, tmp_path, monkeypatch = setup

    today = date.today().isoformat()
    _seed_snapshot(db_path, today, vo2max_score=65.0)

    goal = {
        "type": "fat_loss",
        "weekly_training_days": 4,
        "available_time_slots": ["evening"],
        "strength_willingness": "conditional",
    }

    import stride_server.routes.predictions as pred_mod

    def _mock_read_json(path):
        if path == f"{USER}/training_goal.json":
            return ({"current": goal, "history": []}, "file")
        return None

    monkeypatch.setattr(pred_mod, "read_json", _mock_read_json)

    resp = client.get(
        f"/api/{USER}/race-predictions",
        headers={"Authorization": f"Bearer {_token(private_pem)}"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["target_gap"] is None


# ---------------------------------------------------------------------------
# Test 5: history?days=30 → series length matches seeded rows
# ---------------------------------------------------------------------------

def test_history_series_length_matches_seeded_rows(setup):
    client, db_path, private_pem, tmp_path, _ = setup

    today = date.today()
    # Seed 3 days within the last 30 days.
    seeded_dates = [today - timedelta(days=i) for i in (0, 7, 14)]
    for d in seeded_dates:
        _seed_snapshot(db_path, d.isoformat(), vo2max_score=70.0 + (today - d).days * 0.1)

    # Also seed 1 day beyond 30 days — should NOT appear.
    old_date = today - timedelta(days=60)
    _seed_snapshot(db_path, old_date.isoformat(), vo2max_score=65.0)

    resp = client.get(
        f"/api/{USER}/race-predictions/history?days=30",
        headers={"Authorization": f"Bearer {_token(private_pem)}"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["user_id"] == USER
    assert body["days"] == 30
    assert "series" in body

    for dist in ("5K", "10K", "HM", "FM"):
        assert dist in body["series"]
        entries = body["series"][dist]
        assert len(entries) == 3, f"{dist}: expected 3 entries, got {len(entries)}"
        # Oldest first.
        dates_in_series = [e["date"] for e in entries]
        assert dates_in_series == sorted(dates_in_series)
        for e in entries:
            assert e["predicted_time_sec"] > 0


# ---------------------------------------------------------------------------
# Test 6: user mismatch → 403
# ---------------------------------------------------------------------------

def test_user_mismatch_returns_403(setup):
    client, db_path, private_pem, tmp_path, _ = setup

    today = date.today().isoformat()
    _seed_snapshot(db_path, today)

    # Token for USER but requesting OTHER user's resource.
    resp = client.get(
        f"/api/{OTHER}/race-predictions",
        headers={"Authorization": f"Bearer {_token(private_pem, sub=USER)}"},
    )
    assert resp.status_code == 403
