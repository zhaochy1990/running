"""Tests for POST/GET /api/{user}/nutrition/meals."""

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

_DATE = "2026-05-12"


# ── RSA fixtures (same pattern as test_training_goal.py) ──────────────────────

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

    from stride_server.bearer import require_bearer, verify_path_user
    from stride_server.routes.nutrition_meals import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(verify_path_user)])

    client = TestClient(app, raise_server_exceptions=False)
    return client, _token(private_pem), tmp_path, private_pem


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _meal_body(**kwargs) -> dict:
    base = {
        "date": _DATE,
        "meal_type": "breakfast",
        "items": [
            {"name": "燕麦粥", "kcal": 250, "protein_g": 8.0, "carb_g": 45.0, "fat_g": 4.0}
        ],
        "notes": None,
    }
    base.update(kwargs)
    return base


# ── 1. POST + GET same date → meals list contains new entry ───────────────────

def test_post_and_get_same_date(app_client):
    client, token, _, _ = app_client
    headers = _auth(token)

    resp = client.post(f"/api/{USER_UUID}/nutrition/meals", json=_meal_body(), headers=headers)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["meal_id"]
    assert data["date"] == _DATE
    assert data["meal_type"] == "breakfast"
    assert data["created_at"]

    get_resp = client.get(f"/api/{USER_UUID}/nutrition/meals?date={_DATE}", headers=headers)
    assert get_resp.status_code == 200, get_resp.text
    body = get_resp.json()
    assert body["date"] == _DATE
    assert len(body["meals"]) == 1
    meal = body["meals"][0]
    assert meal["meal_id"] == data["meal_id"]
    assert meal["meal_type"] == "breakfast"
    assert len(meal["items"]) == 1
    assert meal["items"][0]["name"] == "燕麦粥"
    assert meal["totals"]["kcal"] == 250.0


# ── 2. Multiple meal_types same date → daily totals accumulate correctly ──────

def test_multiple_meal_types_daily_totals(app_client):
    client, token, _, _ = app_client
    headers = _auth(token)

    # breakfast: 250 kcal, 8 protein, 45 carb, 4 fat
    client.post(f"/api/{USER_UUID}/nutrition/meals",
                json=_meal_body(meal_type="breakfast"), headers=headers)

    # lunch: 600 kcal, 40 protein, 70 carb, 15 fat
    client.post(
        f"/api/{USER_UUID}/nutrition/meals",
        json=_meal_body(
            meal_type="lunch",
            items=[{"name": "鸡胸饭", "kcal": 600, "protein_g": 40.0, "carb_g": 70.0, "fat_g": 15.0}],
        ),
        headers=headers,
    )

    get_resp = client.get(f"/api/{USER_UUID}/nutrition/meals?date={_DATE}", headers=headers)
    assert get_resp.status_code == 200, get_resp.text
    body = get_resp.json()
    assert len(body["meals"]) == 2

    totals = body["daily_totals"]
    assert totals["kcal"] == pytest.approx(850.0)
    assert totals["protein_g"] == pytest.approx(48.0)
    assert totals["carb_g"] == pytest.approx(115.0)
    assert totals["fat_g"] == pytest.approx(19.0)


# ── 3. items empty → 422 ──────────────────────────────────────────────────────

def test_empty_items_returns_422(app_client):
    client, token, _, _ = app_client
    resp = client.post(
        f"/api/{USER_UUID}/nutrition/meals",
        json=_meal_body(items=[]),
        headers=_auth(token),
    )
    assert resp.status_code == 422, resp.text


# ── 4. Negative kcal → 422 ───────────────────────────────────────────────────

def test_negative_kcal_returns_422(app_client):
    client, token, _, _ = app_client
    resp = client.post(
        f"/api/{USER_UUID}/nutrition/meals",
        json=_meal_body(
            items=[{"name": "bad", "kcal": -10, "protein_g": 0, "carb_g": 0, "fat_g": 0}]
        ),
        headers=_auth(token),
    )
    assert resp.status_code == 422, resp.text


# ── 5. No token → 401 ─────────────────────────────────────────────────────────

def test_no_token_returns_401(app_client):
    client, _, _, _ = app_client
    resp = client.post(f"/api/{USER_UUID}/nutrition/meals", json=_meal_body())
    assert resp.status_code == 401, resp.text


# ── 6. User mismatch → 403 ───────────────────────────────────────────────────

def test_user_mismatch_returns_403(app_client):
    client, _, _, private_pem = app_client
    # token for OTHER_UUID but path is USER_UUID
    other_token = _token(private_pem, sub=OTHER_UUID)
    resp = client.post(
        f"/api/{USER_UUID}/nutrition/meals",
        json=_meal_body(),
        headers=_auth(other_token),
    )
    assert resp.status_code == 403, resp.text


# ── 7. GET non-existent date → 200 + meals=[] + totals all 0 ─────────────────

def test_get_nonexistent_date_returns_empty(app_client):
    client, token, _, _ = app_client
    resp = client.get(
        f"/api/{USER_UUID}/nutrition/meals?date=2020-01-01",
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["date"] == "2020-01-01"
    assert body["meals"] == []
    totals = body["daily_totals"]
    assert totals["kcal"] == 0.0
    assert totals["protein_g"] == 0.0
    assert totals["carb_g"] == 0.0
    assert totals["fat_g"] == 0.0
