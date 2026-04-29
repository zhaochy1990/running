"""Tests for self-service account deletion."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock

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


def _make_token(private_pem: str, sub: str = USER_UUID) -> str:
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

    import stride_server.routes.account as account_mod
    monkeypatch.setattr(account_mod, "USER_DATA_DIR", tmp_path)

    from stride_server.bearer import require_bearer
    from stride_server.routes.account import router

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(require_bearer)])

    token = _make_token(private_pem)
    client = TestClient(app, raise_server_exceptions=False)
    return client, token, tmp_path


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_delete_account_deletes_local_data_after_auth_delete(app_client, monkeypatch):
    client, token, tmp_path = app_client
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()
    (user_dir / "profile.json").write_text("{}")
    (user_dir / "coros.db").write_text("sqlite")
    seen: dict = {}

    async def fake_delete_my_account(bearer):
        seen["bearer"] = bearer

    import stride_server.auth_service_client as ac
    monkeypatch.setattr(ac, "delete_my_account", fake_delete_my_account)

    resp = client.delete("/api/users/me", headers=_auth(token))

    assert resp.status_code == 204
    assert not user_dir.exists()
    assert seen["bearer"] == token


def test_delete_account_keeps_local_data_when_auth_service_blocks(app_client, monkeypatch):
    client, token, tmp_path = app_client
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()
    (user_dir / "profile.json").write_text("{}")

    import stride_server.auth_service_client as ac

    async def fake_delete_my_account(_bearer):
        raise ac.AuthServiceError(409, "user owns teams")

    monkeypatch.setattr(ac, "delete_my_account", fake_delete_my_account)

    resp = client.delete("/api/users/me", headers=_auth(token))

    assert resp.status_code == 409
    assert user_dir.exists()


def test_delete_account_finishes_local_cleanup_when_auth_account_is_already_gone(app_client, monkeypatch):
    client, token, tmp_path = app_client
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir()
    (user_dir / "profile.json").write_text("{}")

    import stride_server.auth_service_client as ac

    async def fake_delete_my_account(_bearer):
        raise ac.AuthServiceError(401, "unauthorized")

    monkeypatch.setattr(ac, "delete_my_account", fake_delete_my_account)

    resp = client.delete("/api/users/me", headers=_auth(token))

    assert resp.status_code == 204
    assert not user_dir.exists()


def test_delete_account_no_auth_returns_401(app_client):
    client, _, _ = app_client
    resp = client.delete("/api/users/me")
    assert resp.status_code == 401


def test_delete_account_rejects_invalid_subject_before_auth_delete(app_client, rsa_keypair, monkeypatch):
    client, _, _ = app_client
    private_pem, _ = rsa_keypair
    token = _make_token(private_pem, sub="not-a-uuid")

    import stride_server.auth_service_client as ac

    delete_my_account = AsyncMock()
    monkeypatch.setattr(ac, "delete_my_account", delete_my_account)

    resp = client.delete("/api/users/me", headers=_auth(token))

    assert resp.status_code == 400
    delete_my_account.assert_not_called()
