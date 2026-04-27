"""Tests for verify_path_user dependency in stride_server.bearer."""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from fastapi.testclient import TestClient


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


def _make_token(private_pem: str, sub: str) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "iss": "auth-service", "exp": now + 3600, "iat": now, "role": "user"},
        private_pem,
        algorithm="RS256",
    )


def _reset_bearer(monkeypatch, public_pem: str) -> None:
    import stride_server.bearer as bearer
    monkeypatch.setattr(bearer, "_cached_public_key", None)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for key in ("STRIDE_AUTH_PUBLIC_KEY_PEM", "STRIDE_AUTH_PUBLIC_KEY_PATH",
                "STRIDE_AUTH_ISSUER", "STRIDE_AUTH_AUDIENCE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)


# --- Unit tests for verify_path_user directly ---

def test_verify_path_user_matching_sub(monkeypatch, rsa_keypair):
    private_pem, public_pem = rsa_keypair
    _reset_bearer(monkeypatch, public_pem)
    from stride_server.bearer import verify_path_user, require_bearer

    token = _make_token(private_pem, "user-uuid-abc")
    payload = require_bearer(authorization=f"Bearer {token}")
    # Should not raise
    verify_path_user(user="user-uuid-abc", payload=payload)


def test_verify_path_user_mismatched_sub_raises_403(monkeypatch, rsa_keypair):
    private_pem, public_pem = rsa_keypair
    _reset_bearer(monkeypatch, public_pem)
    from stride_server.bearer import verify_path_user, require_bearer

    token = _make_token(private_pem, "user-uuid-abc")
    payload = require_bearer(authorization=f"Bearer {token}")
    with pytest.raises(HTTPException) as exc:
        verify_path_user(user="different-uuid", payload=payload)
    assert exc.value.status_code == 403


def test_verify_path_user_open_mode_anonymous_raises_403(monkeypatch):
    import stride_server.bearer as bearer
    monkeypatch.setattr(bearer, "_cached_public_key", None)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for key in ("STRIDE_AUTH_PUBLIC_KEY_PEM", "STRIDE_AUTH_PUBLIC_KEY_PATH",
                "STRIDE_AUTH_ISSUER", "STRIDE_AUTH_AUDIENCE"):
        monkeypatch.delenv(key, raising=False)

    from stride_server.bearer import verify_path_user, require_bearer
    # Open mode returns anonymous sub
    payload = require_bearer(authorization=None)
    assert payload["sub"] == "anonymous"

    # Any real UUID path should raise 403 against anonymous
    with pytest.raises(HTTPException) as exc:
        verify_path_user(user="some-real-uuid", payload=payload)
    assert exc.value.status_code == 403


# --- Integration test via TestClient against a minimal FastAPI app ---

def _build_test_app(public_pem: str):
    """Build a minimal FastAPI app that uses verify_path_user on /api/{user}/ping."""
    import stride_server.bearer as bearer
    bearer._cached_public_key = public_pem
    bearer._warned_open = False

    from fastapi import FastAPI, Depends
    from stride_server.bearer import verify_path_user

    app = FastAPI()

    @app.get("/api/{user}/ping")
    def ping(user: str, _=Depends(verify_path_user)):
        return {"ok": True, "user": user}

    return app


def test_integration_matching_uuid_returns_200(monkeypatch, rsa_keypair):
    private_pem, public_pem = rsa_keypair
    _reset_bearer(monkeypatch, public_pem)

    app = _build_test_app(public_pem)
    client = TestClient(app, raise_server_exceptions=False)

    uuid = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
    token = _make_token(private_pem, uuid)
    resp = client.get(f"/api/{uuid}/ping", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json()["user"] == uuid


def test_integration_mismatched_uuid_returns_403(monkeypatch, rsa_keypair):
    private_pem, public_pem = rsa_keypair
    _reset_bearer(monkeypatch, public_pem)

    app = _build_test_app(public_pem)
    client = TestClient(app, raise_server_exceptions=False)

    token_uuid = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
    path_uuid = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    token = _make_token(private_pem, token_uuid)
    resp = client.get(f"/api/{path_uuid}/ping", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403


def test_integration_no_token_returns_401(monkeypatch, rsa_keypair):
    _, public_pem = rsa_keypair
    _reset_bearer(monkeypatch, public_pem)

    app = _build_test_app(public_pem)
    client = TestClient(app, raise_server_exceptions=False)

    uuid = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
    resp = client.get(f"/api/{uuid}/ping")
    assert resp.status_code == 401


# --- Fail-closed startup tests ---

class _StubSource:
    """Minimal DataSource-ish stub for create_app() in tests."""
    def is_logged_in(self, user: str) -> bool:
        return True


def test_create_app_raises_when_no_key_and_no_dev_env(monkeypatch):
    """In production-like configs (no public key, no dev env), startup must fail."""
    import stride_server.bearer as bearer
    monkeypatch.setattr(bearer, "_cached_public_key", None)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for key in ("STRIDE_AUTH_PUBLIC_KEY_PEM", "STRIDE_AUTH_PUBLIC_KEY_PATH",
                "STRIDE_AUTH_ISSUER", "STRIDE_AUTH_AUDIENCE", "STRIDE_ENV"):
        monkeypatch.delenv(key, raising=False)

    from stride_server.app import create_app
    with pytest.raises(RuntimeError, match="STRIDE auth not configured"):
        create_app(_StubSource())


def test_create_app_succeeds_with_dev_env(monkeypatch):
    """STRIDE_ENV=dev permits fail-open (legacy dev behaviour)."""
    import stride_server.bearer as bearer
    monkeypatch.setattr(bearer, "_cached_public_key", None)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for key in ("STRIDE_AUTH_PUBLIC_KEY_PEM", "STRIDE_AUTH_PUBLIC_KEY_PATH",
                "STRIDE_AUTH_ISSUER", "STRIDE_AUTH_AUDIENCE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("STRIDE_ENV", "dev")

    from stride_server.app import create_app
    app = create_app(_StubSource())
    assert app is not None


def test_create_app_succeeds_when_public_key_set(monkeypatch, rsa_keypair):
    """A configured public key satisfies the fail-closed check, no dev needed."""
    _, public_pem = rsa_keypair
    import stride_server.bearer as bearer
    monkeypatch.setattr(bearer, "_cached_public_key", None)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for key in ("STRIDE_AUTH_PUBLIC_KEY_PATH", "STRIDE_AUTH_ISSUER",
                "STRIDE_AUTH_AUDIENCE", "STRIDE_ENV"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)

    from stride_server.app import create_app
    app = create_app(_StubSource())
    assert app is not None
