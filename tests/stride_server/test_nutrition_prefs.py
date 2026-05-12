"""Tests for GET/PUT /api/users/me/nutrition-prefs."""

from __future__ import annotations

import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"


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

    import stride_core.db as _cdb
    monkeypatch.setattr(_cdb, "USER_DATA_DIR", tmp_path)

    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)

    from stride_server.bearer import require_bearer
    from stride_server.routes.nutrition_prefs import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer)])

    client = TestClient(app, raise_server_exceptions=False)
    return client, _token(private_pem), tmp_path, private_pem


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _prefs(extra: dict | None = None) -> dict:
    base = {
        "enabled": True,
        "diet_type": "none",
        "allergies": ["gluten", "dairy"],
        "goal": "fat_loss",
        "bmr_kcal": 1800.0,
        "tdee_kcal": 2400.0,
        "macro_protein_pct": 30.0,
        "macro_carb_pct": 40.0,
        "macro_fat_pct": 30.0,
    }
    if extra:
        base.update(extra)
    return base


# ── 1. PUT 创建 → GET 返回 ────────────────────────────────────────────────────

def test_put_create_and_get(app_client):
    client, token, _, _ = app_client
    headers = _auth(token)

    resp = client.put("/api/users/me/nutrition-prefs", json=_prefs(), headers=headers)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["enabled"] is True
    assert data["diet_type"] == "none"
    assert data["goal"] == "fat_loss"
    assert data["macro_protein_pct"] == 30.0
    assert data["created_at"] is not None
    assert data["updated_at"] is not None

    # GET 返回同一条记录
    resp2 = client.get("/api/users/me/nutrition-prefs", headers=headers)
    assert resp2.status_code == 200, resp2.text
    data2 = resp2.json()
    assert data2["goal"] == "fat_loss"
    assert data2["allergies"] == ["gluten", "dairy"]


# ── 2. GET 无数据 → 404 ───────────────────────────────────────────────────────

def test_get_no_data_returns_404(app_client):
    client, token, _, _ = app_client
    resp = client.get("/api/users/me/nutrition-prefs", headers=_auth(token))
    assert resp.status_code == 404, resp.text


# ── 3. PUT 二次更新 → 200，history 增 1 ──────────────────────────────────────

def test_put_second_update_adds_history(app_client):
    client, token, tmp_path, _ = app_client
    headers = _auth(token)

    # 第一次 PUT
    r1 = client.put("/api/users/me/nutrition-prefs", json=_prefs(), headers=headers)
    assert r1.status_code == 200

    # 第二次 PUT（修改 goal）
    r2 = client.put(
        "/api/users/me/nutrition-prefs",
        json=_prefs({"goal": "maintain"}),
        headers=headers,
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["goal"] == "maintain"

    # 直接读 JSON 文件验证 history
    store_path = tmp_path / USER_UUID / "nutrition_prefs.json"
    store = json.loads(store_path.read_text())
    assert store["current"]["goal"] == "maintain"
    assert len(store["history"]) == 1
    assert store["history"][0]["goal"] == "fat_loss"


# ── 4. macro pct 不和 100 → 422 ──────────────────────────────────────────────

def test_macro_pct_not_100_returns_422(app_client):
    client, token, _, _ = app_client
    bad = _prefs({"macro_protein_pct": 40.0, "macro_carb_pct": 40.0, "macro_fat_pct": 40.0})
    resp = client.put("/api/users/me/nutrition-prefs", json=bad, headers=_auth(token))
    assert resp.status_code == 422, resp.text


# ── 5. allergies 超 20 → 422 ─────────────────────────────────────────────────

def test_allergies_over_20_returns_422(app_client):
    client, token, _, _ = app_client
    bad = _prefs({"allergies": [f"item{i}" for i in range(21)]})
    resp = client.put("/api/users/me/nutrition-prefs", json=bad, headers=_auth(token))
    assert resp.status_code == 422, resp.text


# ── 6. 未带 token → 401 ───────────────────────────────────────────────────────

def test_no_token_returns_401(app_client):
    client, _, _, _ = app_client

    resp_get = client.get("/api/users/me/nutrition-prefs")
    assert resp_get.status_code == 401, resp_get.text

    resp_put = client.put("/api/users/me/nutrition-prefs", json=_prefs())
    assert resp_put.status_code == 401, resp_put.text
