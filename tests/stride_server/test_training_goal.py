"""Tests for POST/GET/PUT /api/users/me/training-goal."""

from __future__ import annotations

import time
from datetime import date, timedelta

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
OTHER_UUID = "b1b2c3d4-e5f6-4aaa-89ab-123456789099"

# A race date that is always in the future
_FUTURE_DATE = (date.today() + timedelta(days=90)).isoformat()


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
    import stride_server.content_store as cs_mod
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)

    # content_store uses core_db.USER_DATA_DIR via _file_path; patch that too
    import stride_core.db as _cdb
    monkeypatch.setattr(_cdb, "USER_DATA_DIR", tmp_path)

    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)

    from stride_server.bearer import require_bearer
    from stride_server.routes.training_goal import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer)])

    client = TestClient(app, raise_server_exceptions=False)
    return client, _token(private_pem), tmp_path, private_pem


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _goal(extra: dict | None = None) -> dict:
    base = {
        "type": "race",
        "race_date": _FUTURE_DATE,
        "race_distance": "FM",
        "target_finish_time": "3:30:00",
        "weekly_training_days": 5,
        "available_time_slots": ["morning", "evening"],
        "strength_willingness": "yes",
    }
    if extra:
        base.update(extra)
    return base


# ── happy path: create + get ──────────────────────────────────────────────────

def test_post_and_get_training_goal(app_client):
    client, token, _, _ = app_client
    headers = _auth(token)

    resp = client.post("/api/users/me/training-goal", json=_goal(), headers=headers)
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["goal_id"] is not None
    assert data["created_at"] is not None
    assert data["updated_at"] is not None
    assert data["type"] == "race"
    assert data["race_distance"] == "FM"

    # GET returns the same goal
    resp2 = client.get("/api/users/me/training-goal", headers=headers)
    assert resp2.status_code == 200, resp2.text
    data2 = resp2.json()
    assert data2["goal_id"] == data["goal_id"]
    assert data2["type"] == "race"


# ── GET returns 404 when no goal exists ───────────────────────────────────────

def test_get_no_goal_returns_404(app_client):
    client, token, _, _ = app_client
    resp = client.get("/api/users/me/training-goal", headers=_auth(token))
    assert resp.status_code == 404, resp.text


# ── PUT updates goal ──────────────────────────────────────────────────────────

def test_put_updates_goal(app_client):
    client, token, _, _ = app_client
    headers = _auth(token)

    post_resp = client.post("/api/users/me/training-goal", json=_goal(), headers=headers)
    goal_id = post_resp.json()["goal_id"]

    updated = _goal({"type": "health", "race_date": None, "race_distance": None,
                     "weekly_training_days": 3, "goal_id": goal_id})
    put_resp = client.put("/api/users/me/training-goal", json=updated, headers=headers)
    assert put_resp.status_code == 200, put_resp.text
    assert put_resp.json()["type"] == "health"
    assert put_resp.json()["weekly_training_days"] == 3


# ── PUT without goal_id → 422 ─────────────────────────────────────────────────

def test_put_without_goal_id_returns_422(app_client):
    client, token, _, _ = app_client
    headers = _auth(token)

    client.post("/api/users/me/training-goal", json=_goal(), headers=headers)

    body = _goal()  # no goal_id key
    resp = client.put("/api/users/me/training-goal", json=body, headers=headers)
    assert resp.status_code == 422, resp.text


# ── PUT with non-existent goal_id → 404 ───────────────────────────────────────

def test_put_nonexistent_goal_id_returns_404(app_client):
    client, token, _, _ = app_client
    headers = _auth(token)

    client.post("/api/users/me/training-goal", json=_goal(), headers=headers)

    body = _goal({"goal_id": "00000000-0000-4000-8000-000000000000"})
    resp = client.put("/api/users/me/training-goal", json=body, headers=headers)
    assert resp.status_code == 404, resp.text


# ── validation: type=race missing race_date → 422 ─────────────────────────────

def test_race_type_missing_race_date_returns_422(app_client):
    client, token, _, _ = app_client
    body = _goal({"race_date": None})
    resp = client.post("/api/users/me/training-goal", json=body, headers=_auth(token))
    assert resp.status_code == 422, resp.text


# ── validation: type=race past race_date → 422 ────────────────────────────────

def test_race_type_past_race_date_returns_422(app_client):
    client, token, _, _ = app_client
    body = _goal({"race_date": "2020-01-01"})
    resp = client.post("/api/users/me/training-goal", json=body, headers=_auth(token))
    assert resp.status_code == 422, resp.text


# ── validation: weekly_training_days out of range ─────────────────────────────

def test_weekly_training_days_too_low_returns_422(app_client):
    client, token, _, _ = app_client
    body = _goal({"weekly_training_days": 2})
    resp = client.post("/api/users/me/training-goal", json=body, headers=_auth(token))
    assert resp.status_code == 422, resp.text


def test_weekly_training_days_too_high_returns_422(app_client):
    client, token, _, _ = app_client
    body = _goal({"weekly_training_days": 7})
    resp = client.post("/api/users/me/training-goal", json=body, headers=_auth(token))
    assert resp.status_code == 422, resp.text


# ── available_time_slots is optional (S1 setup form omits it) ────────────────

def test_empty_available_time_slots_allowed(app_client):
    # The S1 season-plan setup form does not collect time slots; an empty list
    # must be accepted (the generator degrades gracefully) rather than 422.
    client, token, _, _ = app_client
    body = _goal({"available_time_slots": []})
    resp = client.post("/api/users/me/training-goal", json=body, headers=_auth(token))
    assert resp.status_code == 201, resp.text
    assert resp.json()["available_time_slots"] == []


# ── history is preserved on overwrite ────────────────────────────────────────

def test_history_preserved_on_second_post(app_client):
    client, token, tmp_path, _ = app_client
    headers = _auth(token)

    r1 = client.post("/api/users/me/training-goal", json=_goal(), headers=headers)
    first_id = r1.json()["goal_id"]

    r2 = client.post("/api/users/me/training-goal", json=_goal({"weekly_training_days": 3}), headers=headers)
    assert r2.status_code == 201
    second_id = r2.json()["goal_id"]
    assert second_id != first_id

    # Read JSON store directly to verify history
    import json
    store_path = tmp_path / USER_UUID / "training_goal.json"
    store = json.loads(store_path.read_text())
    assert store["current"]["goal_id"] == second_id
    assert len(store["history"]) == 1
    assert store["history"][0]["goal_id"] == first_id
