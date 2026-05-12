"""Tests for POST/GET/PUT /api/users/me/running-profile."""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
OTHER_UUID = "b1b2c3d4-e5f6-4aaa-89ab-123456789099"


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
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)

    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)

    from stride_server.bearer import require_bearer
    from stride_server.routes.running_profile import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer)])

    client = TestClient(app, raise_server_exceptions=False)
    return client, _token(private_pem), tmp_path, private_pem


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _profile(extra: dict | None = None) -> dict:
    base = {
        "running_age": "1y_3y",
        "current_weekly_km": "20_40",
        "pbs": [
            {"distance": "HM", "time": "1:55:00"},
            {"distance": "FM", "time": "4:10:00"},
        ],
        "injuries": ["none"],
    }
    if extra:
        base.update(extra)
    return base


# ── happy path: create + get ──────────────────────────────────────────────────

def test_post_and_get_running_profile(app_client):
    client, token, _, _ = app_client
    headers = _auth(token)

    resp = client.post("/api/users/me/running-profile", json=_profile(), headers=headers)
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["profile_id"] is not None
    assert data["created_at"] is not None
    assert data["updated_at"] is not None
    assert data["running_age"] == "1y_3y"
    assert len(data["pbs"]) == 2

    # GET returns the same profile
    resp2 = client.get("/api/users/me/running-profile", headers=headers)
    assert resp2.status_code == 200, resp2.text
    data2 = resp2.json()
    assert data2["profile_id"] == data["profile_id"]
    assert data2["running_age"] == "1y_3y"


# ── GET returns 404 when no profile exists ────────────────────────────────────

def test_get_no_profile_returns_404(app_client):
    client, token, _, _ = app_client
    resp = client.get("/api/users/me/running-profile", headers=_auth(token))
    assert resp.status_code == 404, resp.text


# ── PUT updates profile ───────────────────────────────────────────────────────

def test_put_updates_profile(app_client):
    client, token, _, _ = app_client
    headers = _auth(token)

    post_resp = client.post("/api/users/me/running-profile", json=_profile(), headers=headers)
    profile_id = post_resp.json()["profile_id"]

    updated = _profile({
        "profile_id": profile_id,
        "running_age": "3y_plus",
        "current_weekly_km": "40_60",
        "injuries": ["knee"],
    })
    put_resp = client.put("/api/users/me/running-profile", json=updated, headers=headers)
    assert put_resp.status_code == 200, put_resp.text
    assert put_resp.json()["running_age"] == "3y_plus"
    assert put_resp.json()["current_weekly_km"] == "40_60"


# ── PUT without profile_id → 422 ─────────────────────────────────────────────

def test_put_without_profile_id_returns_422(app_client):
    client, token, _, _ = app_client
    headers = _auth(token)

    client.post("/api/users/me/running-profile", json=_profile(), headers=headers)

    body = _profile()  # no profile_id
    resp = client.put("/api/users/me/running-profile", json=body, headers=headers)
    assert resp.status_code == 422, resp.text


# ── PUT with non-existent profile_id → 404 ───────────────────────────────────

def test_put_nonexistent_profile_id_returns_404(app_client):
    client, token, _, _ = app_client
    headers = _auth(token)

    client.post("/api/users/me/running-profile", json=_profile(), headers=headers)

    body = _profile({"profile_id": "00000000-0000-4000-8000-000000000000"})
    resp = client.put("/api/users/me/running-profile", json=body, headers=headers)
    assert resp.status_code == 404, resp.text


# ── validation: duplicate pb distance → 422 ──────────────────────────────────

def test_duplicate_pb_distance_returns_422(app_client):
    client, token, _, _ = app_client
    body = _profile({
        "pbs": [
            {"distance": "HM", "time": "1:55:00"},
            {"distance": "HM", "time": "1:50:00"},  # duplicate
        ]
    })
    resp = client.post("/api/users/me/running-profile", json=body, headers=_auth(token))
    assert resp.status_code == 422, resp.text


# ── validation: pb time wrong format → 422 ───────────────────────────────────

def test_pb_time_bad_format_returns_422(app_client):
    client, token, _, _ = app_client
    body = _profile({
        "pbs": [{"distance": "5K", "time": "21:30"}]  # missing seconds
    })
    resp = client.post("/api/users/me/running-profile", json=body, headers=_auth(token))
    assert resp.status_code == 422, resp.text


# ── validation: injuries "none" with others → 422 ────────────────────────────

def test_injuries_none_with_others_returns_422(app_client):
    client, token, _, _ = app_client
    body = _profile({"injuries": ["none", "knee"]})
    resp = client.post("/api/users/me/running-profile", json=body, headers=_auth(token))
    assert resp.status_code == 422, resp.text


# ── empty pbs list is valid ───────────────────────────────────────────────────

def test_empty_pbs_is_valid(app_client):
    client, token, _, _ = app_client
    body = _profile({"pbs": [], "injuries": ["knee", "plantar_fasciitis"]})
    resp = client.post("/api/users/me/running-profile", json=body, headers=_auth(token))
    assert resp.status_code == 201, resp.text
    assert resp.json()["pbs"] == []


# ── history is preserved on overwrite ────────────────────────────────────────

def test_history_preserved_on_second_post(app_client):
    client, token, tmp_path, _ = app_client
    headers = _auth(token)

    r1 = client.post("/api/users/me/running-profile", json=_profile(), headers=headers)
    first_id = r1.json()["profile_id"]

    r2 = client.post(
        "/api/users/me/running-profile",
        json=_profile({"running_age": "3y_plus"}),
        headers=headers,
    )
    assert r2.status_code == 201
    second_id = r2.json()["profile_id"]
    assert second_id != first_id

    import json
    store_path = tmp_path / USER_UUID / "running_profile.json"
    store = json.loads(store_path.read_text())
    assert store["current"]["profile_id"] == second_id
    assert len(store["history"]) == 1
    assert store["history"][0]["profile_id"] == first_id
