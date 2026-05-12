"""Tests for /api/users/me/onboarding/defaults (T17)."""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone

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
    import stride_server.deps as deps_mod
    import stride_server.content_store as content_store_mod
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)
    if hasattr(content_store_mod, "USER_DATA_DIR"):
        monkeypatch.setattr(content_store_mod, "USER_DATA_DIR", tmp_path)
    if hasattr(content_store_mod, "_LOCAL_BASE"):
        monkeypatch.setattr(content_store_mod, "_LOCAL_BASE", tmp_path)

    from stride_server.bearer import require_bearer
    from stride_server.routes.onboarding import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer)])

    client = TestClient(app, raise_server_exceptions=False)
    return client, _token(private_pem), tmp_path, private_pem


def _seed_profile(tmp_path, *, birth_year: int | None):
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)
    data: dict = {}
    if birth_year is not None:
        data["birth_year"] = birth_year
    (user_dir / "profile.json").write_text(json.dumps(data), encoding="utf-8")


def _seed_health_rhr(tmp_path, values: list[int]):
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)
    (user_dir / "config.json").write_text(json.dumps({"provider": "coros"}), encoding="utf-8")

    from stride_core.db import Database
    db = Database(user=USER_UUID)
    for i, rhr in enumerate(values):
        db._conn.execute(
            "INSERT INTO daily_health (date, rhr) VALUES (?, ?)",
            (f"2026-05-{(10 - i) % 31 + 1:02d}", rhr),
        )
    db._conn.commit()
    db.close()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_defaults_full(app_client):
    client, token, tmp_path, _ = app_client
    _seed_profile(tmp_path, birth_year=1990)
    _seed_health_rhr(tmp_path, [55, 53, 54, 56, 52, 58, 57, 55, 53, 54])

    resp = client.get("/api/users/me/onboarding/defaults", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rhr_source"] == "health"
    assert body["suggested_rhr"] is not None
    assert 50 <= body["suggested_rhr"] <= 58
    expected_max = 220 - (datetime.now(timezone.utc).year - 1990)
    assert body["suggested_max_hr"] == expected_max
    assert body["max_hr_source"] == "formula"


def test_defaults_empty_user(app_client):
    client, token, _tmp, _ = app_client
    resp = client.get("/api/users/me/onboarding/defaults", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["suggested_rhr"] is None
    assert body["rhr_source"] is None
    assert body["suggested_max_hr"] is None
    assert body["max_hr_source"] is None


def test_defaults_unauthorized(app_client):
    client, _token, _tmp, _ = app_client
    resp = client.get("/api/users/me/onboarding/defaults")
    assert resp.status_code == 401


def test_defaults_birth_year_only(app_client):
    client, token, tmp_path, _ = app_client
    _seed_profile(tmp_path, birth_year=1985)
    resp = client.get("/api/users/me/onboarding/defaults", headers=_auth(token))
    assert resp.status_code == 200
    body = resp.json()
    assert body["suggested_rhr"] is None
    assert body["rhr_source"] is None
    assert body["suggested_max_hr"] == 220 - (datetime.now(timezone.utc).year - 1985)
    assert body["max_hr_source"] == "formula"


def test_defaults_health_only(app_client):
    client, token, tmp_path, _ = app_client
    _seed_health_rhr(tmp_path, [50, 52, 51, 53, 49, 50, 51])
    resp = client.get("/api/users/me/onboarding/defaults", headers=_auth(token))
    assert resp.status_code == 200
    body = resp.json()
    assert body["suggested_rhr"] is not None
    assert body["rhr_source"] == "health"
    assert body["suggested_max_hr"] is None
    assert body["max_hr_source"] is None
