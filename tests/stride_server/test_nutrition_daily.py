"""Tests for GET /api/{user}/nutrition/daily (US-002)."""

from __future__ import annotations

import json
import time
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
OTHER_UUID = "b1b2c3d4-e5f6-4aaa-89ab-123456789099"

# A minimal valid prefs dict (macro pcts sum to 100)
_BASE_PREFS: dict[str, Any] = {
    "enabled": True,
    "diet_type": "none",
    "allergies": [],
    "goal": "fat_loss",
    "tdee_kcal": 2200.0,
    "bmr_kcal": 1550.0,
    "macro_protein_pct": 30.0,
    "macro_carb_pct": 45.0,
    "macro_fat_pct": 25.0,
}


# ── Fixtures ──────────────────────────────────────────────────────────────────

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
    import stride_server.content_store as content_store_mod
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)
    if hasattr(content_store_mod, "USER_DATA_DIR"):
        monkeypatch.setattr(content_store_mod, "USER_DATA_DIR", tmp_path)

    from stride_server.bearer import require_bearer, verify_path_user
    from stride_server.routes.nutrition_daily import router

    app = FastAPI()
    # protect_user: require_bearer first, then verify_path_user
    app.include_router(router, dependencies=[Depends(verify_path_user)])

    client = TestClient(app, raise_server_exceptions=False)
    return client, _token(private_pem), tmp_path, private_pem


# ── Helpers ───────────────────────────────────────────────────────────────────

def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _write_prefs(tmp_path, user: str = USER_UUID, prefs: dict | None = None):
    """Write nutrition_prefs.json for user."""
    user_dir = tmp_path / user
    user_dir.mkdir(parents=True, exist_ok=True)
    current = dict(_BASE_PREFS)
    if prefs:
        current.update(prefs)
    store = {"current": current, "history": []}
    (user_dir / "nutrition_prefs.json").write_text(
        json.dumps(store), encoding="utf-8"
    )


def _seed_planned_session(tmp_path, user: str, date: str, kind: str, spec_json: str | None = None):
    """Insert a planned_session row into the user's SQLite DB."""
    user_dir = tmp_path / user
    user_dir.mkdir(parents=True, exist_ok=True)
    # Ensure config.json exists so Database() can open
    config_path = user_dir / "config.json"
    if not config_path.exists():
        config_path.write_text(json.dumps({"provider": "coros"}), encoding="utf-8")

    from stride_core.db import Database
    db = Database(user=user)
    db._conn.execute(
        """INSERT INTO planned_session
           (week_folder, date, session_index, kind, summary, spec_json)
           VALUES (?, ?, ?, ?, ?, ?)""",
        ("2026-05-11_05-17(W1)", date, 0, kind, f"{kind} session", spec_json),
    )
    db._conn.commit()
    db.close()


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_training_day_with_prefs_returns_200_and_correct_macros(app_client):
    """Training day + prefs → 200, target_kcal = tdee + 200, macros correct."""
    client, token, tmp_path, _ = app_client
    _write_prefs(tmp_path)  # tdee=2200, protein=30%, carb=45%, fat=25%
    _seed_planned_session(tmp_path, USER_UUID, "2026-05-12", "run")

    resp = client.get(
        f"/api/{USER_UUID}/nutrition/daily?date=2026-05-12",
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["user_id"] == USER_UUID
    assert body["date"] == "2026-05-12"
    assert body["is_training_day"] is True

    # target_kcal = 2200 + 200 = 2400
    assert body["target_kcal"] == 2400

    # protein_g = round((2400 * 30 / 100) / 4) = round(180) = 180
    assert body["macros"]["protein_g"] == 180
    # carb_g = round((2400 * 45 / 100) / 4) = round(270) = 270
    assert body["macros"]["carb_g"] == 270
    # fat_g = round((2400 * 25 / 100) / 9) = round(66.67) = 67
    assert body["macros"]["fat_g"] == 67

    # Advice should be non-empty strings (run session → easy bucket by default)
    assert body["advice"]["pre"] != "—"
    assert body["advice"]["post"] != "—"


def test_rest_day_with_prefs_target_kcal_equals_tdee(app_client):
    """Rest day → target_kcal == tdee_kcal (no training bonus), advice all '—'."""
    client, token, tmp_path, _ = app_client
    _write_prefs(tmp_path)  # tdee=2200

    # No planned_session for this date → rest day
    resp = client.get(
        f"/api/{USER_UUID}/nutrition/daily?date=2026-05-13",
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["is_training_day"] is False
    assert body["target_kcal"] == 2200  # no bonus

    assert body["advice"]["pre"] == "—"
    assert body["advice"]["intra"] == "—"
    assert body["advice"]["post"] == "—"


def test_no_prefs_returns_404(app_client):
    """Missing nutrition_prefs.json → 404."""
    client, token, tmp_path, _ = app_client
    # Don't write any prefs

    resp = client.get(
        f"/api/{USER_UUID}/nutrition/daily?date=2026-05-12",
        headers=_auth(token),
    )
    assert resp.status_code == 404, resp.text
    assert "营养偏好" in resp.json()["detail"]


def test_missing_date_param_returns_422(app_client):
    """Omitting date query param → 422 from FastAPI validation."""
    client, token, tmp_path, _ = app_client
    _write_prefs(tmp_path)

    resp = client.get(
        f"/api/{USER_UUID}/nutrition/daily",
        headers=_auth(token),
    )
    assert resp.status_code == 422, resp.text


def test_tempo_session_advice_post_contains_protein(app_client):
    """T-type (tempo/interval) session → advice.post mentions protein supplement."""
    client, token, tmp_path, _ = app_client
    _write_prefs(tmp_path)
    # Seed a run session with spec_json carrying run_type='T'
    spec = json.dumps({"run_type": "T", "distance_m": 10000})
    _seed_planned_session(tmp_path, USER_UUID, "2026-05-14", "run", spec_json=spec)

    resp = client.get(
        f"/api/{USER_UUID}/nutrition/daily?date=2026-05-14",
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["is_training_day"] is True
    # Hard/tempo advice post mentions protein
    assert "蛋白" in body["advice"]["post"]


def test_user_mismatch_returns_403(app_client):
    """JWT sub != path user → 403."""
    client, token, tmp_path, private_pem = app_client
    _write_prefs(tmp_path)

    # Token is for USER_UUID but path uses OTHER_UUID
    resp = client.get(
        f"/api/{OTHER_UUID}/nutrition/daily?date=2026-05-12",
        headers=_auth(token),
    )
    assert resp.status_code == 403, resp.text


def test_strength_session_advice_uses_strength_template(app_client):
    """Strength session → advice uses strength template (pre mentions protein)."""
    client, token, tmp_path, _ = app_client
    _write_prefs(tmp_path)
    _seed_planned_session(tmp_path, USER_UUID, "2026-05-15", "strength")

    resp = client.get(
        f"/api/{USER_UUID}/nutrition/daily?date=2026-05-15",
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["is_training_day"] is True
    # Strength template pre mentions protein
    assert "蛋白" in body["advice"]["pre"]


def test_fallback_to_bmr_when_tdee_missing(app_client):
    """When tdee_kcal is null, falls back to bmr_kcal * 1.5."""
    client, token, tmp_path, _ = app_client
    _write_prefs(tmp_path, prefs={"tdee_kcal": None, "bmr_kcal": 1600.0})

    resp = client.get(
        f"/api/{USER_UUID}/nutrition/daily?date=2026-05-16",
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # base = 1600 * 1.5 = 2400; rest day → no bonus → target = 2400
    assert body["target_kcal"] == 2400
