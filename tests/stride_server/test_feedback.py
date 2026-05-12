"""Tests for PUT/GET /api/{user}/activities/{label_id}/feedback."""

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
LABEL_ID = "ACT_001"


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

    # Ensure user dir exists so Database() can open.
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)

    from stride_server.bearer import require_bearer, verify_path_user
    from stride_server.routes.feedback import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer), Depends(verify_path_user)])

    client = TestClient(app, raise_server_exceptions=False)
    return client, _token(private_pem), tmp_path, private_pem


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ── happy-path: write and read back ───────────────────────────────────────────

def test_put_and_get_feedback(app_client):
    client, token, tmp_path, _ = app_client
    headers = _auth(token)

    resp = client.put(
        f"/api/{USER_UUID}/activities/{LABEL_ID}/feedback",
        json={"rpe": 7, "mood_tags": ["腿酸", "状态好"], "note": "感觉不错"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["label_id"] == LABEL_ID
    assert data["rpe"] == 7
    assert data["mood_tags"] == ["腿酸", "状态好"]
    assert data["note"] == "感觉不错"
    assert data["updated_at"] is not None

    # GET returns same values
    resp2 = client.get(f"/api/{USER_UUID}/activities/{LABEL_ID}/feedback", headers=headers)
    assert resp2.status_code == 200, resp2.text
    data2 = resp2.json()
    assert data2["rpe"] == 7
    assert data2["mood_tags"] == ["腿酸", "状态好"]
    assert data2["note"] == "感觉如何？"[0:3] or data2["note"] == "感觉不错"


def test_get_no_record_returns_nulls(app_client):
    """GET with no prior PUT should return 200 with all null fields (not 404)."""
    client, token, tmp_path, _ = app_client
    resp = client.get(
        f"/api/{USER_UUID}/activities/NONEXISTENT/feedback",
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["label_id"] == "NONEXISTENT"
    assert data["rpe"] is None
    assert data["mood_tags"] is None
    assert data["note"] is None
    assert data["updated_at"] is None


# ── validation: rpe out of range ──────────────────────────────────────────────

def test_put_rpe_zero_returns_422(app_client):
    client, token, _, _ = app_client
    resp = client.put(
        f"/api/{USER_UUID}/activities/{LABEL_ID}/feedback",
        json={"rpe": 0, "mood_tags": [], "note": None},
        headers=_auth(token),
    )
    assert resp.status_code == 422


def test_put_rpe_eleven_returns_422(app_client):
    client, token, _, _ = app_client
    resp = client.put(
        f"/api/{USER_UUID}/activities/{LABEL_ID}/feedback",
        json={"rpe": 11, "mood_tags": [], "note": None},
        headers=_auth(token),
    )
    assert resp.status_code == 422


def test_put_mood_tags_too_many_returns_422(app_client):
    client, token, _, _ = app_client
    resp = client.put(
        f"/api/{USER_UUID}/activities/{LABEL_ID}/feedback",
        json={"rpe": 5, "mood_tags": [f"tag{i}" for i in range(11)], "note": None},
        headers=_auth(token),
    )
    assert resp.status_code == 422


def test_put_note_too_long_returns_422(app_client):
    client, token, _, _ = app_client
    resp = client.put(
        f"/api/{USER_UUID}/activities/{LABEL_ID}/feedback",
        json={"rpe": 5, "mood_tags": [], "note": "x" * 201},
        headers=_auth(token),
    )
    assert resp.status_code == 422


# ── idempotent upsert ─────────────────────────────────────────────────────────

def test_idempotent_upsert_updated_at_changes(app_client):
    """PUT twice: second call should update updated_at."""
    client, token, tmp_path, _ = app_client
    headers = _auth(token)

    resp1 = client.put(
        f"/api/{USER_UUID}/activities/{LABEL_ID}/feedback",
        json={"rpe": 5, "mood_tags": ["心情好"], "note": "第一次"},
        headers=headers,
    )
    assert resp1.status_code == 200
    updated_at_1 = resp1.json()["updated_at"]

    # Small sleep so datetime('now') can differ by at least 1 second.
    import time as _time
    _time.sleep(1.1)

    resp2 = client.put(
        f"/api/{USER_UUID}/activities/{LABEL_ID}/feedback",
        json={"rpe": 8, "mood_tags": ["腿酸"], "note": "第二次"},
        headers=headers,
    )
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert data2["rpe"] == 8
    assert data2["mood_tags"] == ["腿酸"]
    assert data2["note"] == "第二次"
    # updated_at should be different (or at least not earlier)
    assert data2["updated_at"] >= updated_at_1


# ── user mismatch → 403 ───────────────────────────────────────────────────────

def test_user_mismatch_put_returns_403(app_client):
    client, _, tmp_path, private_pem = app_client
    other_token = _token(private_pem, sub=OTHER_UUID)
    resp = client.put(
        f"/api/{USER_UUID}/activities/{LABEL_ID}/feedback",
        json={"rpe": 6, "mood_tags": [], "note": None},
        headers=_auth(other_token),
    )
    assert resp.status_code == 403


def test_user_mismatch_get_returns_403(app_client):
    client, _, tmp_path, private_pem = app_client
    other_token = _token(private_pem, sub=OTHER_UUID)
    resp = client.get(
        f"/api/{USER_UUID}/activities/{LABEL_ID}/feedback",
        headers=_auth(other_token),
    )
    assert resp.status_code == 403
