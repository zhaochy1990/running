"""Tests for stride_server.bearer — verify RS256 Bearer auth behaviour."""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException


@pytest.fixture
def rsa_keypair():
    """Generate a short-lived RSA keypair in PEM format for tests."""
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


def _issue(private_pem: str, **overrides) -> str:
    now = int(time.time())
    claims = {
        "sub": "user-123",
        "aud": "stride-client",
        "iss": "auth-service",
        "exp": now + 3600,
        "iat": now,
        "scopes": ["write"],
        "role": "user",
    }
    claims.update(overrides)
    return jwt.encode(claims, private_pem, algorithm="RS256")


def _reset_module_state(monkeypatch, env: dict | None = None):
    """Reset the bearer module's cached key + warning flag + env between tests."""
    import stride_server.bearer as bearer
    monkeypatch.setattr(bearer, "_cached_public_key", None)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for key in (
        "STRIDE_AUTH_PUBLIC_KEY_PEM",
        "STRIDE_AUTH_PUBLIC_KEY_PATH",
        "STRIDE_AUTH_ISSUER",
        "STRIDE_AUTH_AUDIENCE",
    ):
        monkeypatch.delenv(key, raising=False)
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)


def test_open_mode_when_key_unset(monkeypatch):
    _reset_module_state(monkeypatch)
    from stride_server.bearer import require_bearer
    claims = require_bearer(authorization=None)
    assert claims == {"sub": "anonymous", "role": "anonymous"}


def test_rejects_missing_header_when_key_configured(monkeypatch, rsa_keypair):
    _, public_pem = rsa_keypair
    _reset_module_state(monkeypatch, {"STRIDE_AUTH_PUBLIC_KEY_PEM": public_pem})
    from stride_server.bearer import require_bearer
    with pytest.raises(HTTPException) as exc:
        require_bearer(authorization=None)
    assert exc.value.status_code == 401


def test_rejects_malformed_header(monkeypatch, rsa_keypair):
    _, public_pem = rsa_keypair
    _reset_module_state(monkeypatch, {"STRIDE_AUTH_PUBLIC_KEY_PEM": public_pem})
    from stride_server.bearer import require_bearer
    with pytest.raises(HTTPException) as exc:
        require_bearer(authorization="NotBearer token")
    assert exc.value.status_code == 401


def test_accepts_valid_token(monkeypatch, rsa_keypair):
    private_pem, public_pem = rsa_keypair
    _reset_module_state(monkeypatch, {"STRIDE_AUTH_PUBLIC_KEY_PEM": public_pem})
    from stride_server.bearer import require_bearer
    token = _issue(private_pem)
    claims = require_bearer(authorization=f"Bearer {token}")
    assert claims["sub"] == "user-123"
    assert claims["role"] == "user"


def test_rejects_wrong_issuer(monkeypatch, rsa_keypair):
    private_pem, public_pem = rsa_keypair
    _reset_module_state(monkeypatch, {"STRIDE_AUTH_PUBLIC_KEY_PEM": public_pem})
    from stride_server.bearer import require_bearer
    token = _issue(private_pem, iss="somebody-else")
    with pytest.raises(HTTPException) as exc:
        require_bearer(authorization=f"Bearer {token}")
    assert exc.value.status_code == 401


def test_rejects_expired_token(monkeypatch, rsa_keypair):
    private_pem, public_pem = rsa_keypair
    _reset_module_state(monkeypatch, {"STRIDE_AUTH_PUBLIC_KEY_PEM": public_pem})
    from stride_server.bearer import require_bearer
    token = _issue(private_pem, exp=int(time.time()) - 10)
    with pytest.raises(HTTPException) as exc:
        require_bearer(authorization=f"Bearer {token}")
    assert exc.value.status_code == 401


def test_audience_check_when_configured(monkeypatch, rsa_keypair):
    private_pem, public_pem = rsa_keypair
    _reset_module_state(
        monkeypatch,
        {
            "STRIDE_AUTH_PUBLIC_KEY_PEM": public_pem,
            "STRIDE_AUTH_AUDIENCE": "stride-client",
        },
    )
    from stride_server.bearer import require_bearer
    good = _issue(private_pem, aud="stride-client")
    assert require_bearer(authorization=f"Bearer {good}")["aud"] == "stride-client"

    bad = _issue(private_pem, aud="other-client")
    with pytest.raises(HTTPException) as exc:
        require_bearer(authorization=f"Bearer {bad}")
    assert exc.value.status_code == 401


def test_pem_path_env(tmp_path, monkeypatch, rsa_keypair):
    _, public_pem = rsa_keypair
    path = tmp_path / "pub.pem"
    path.write_text(public_pem)
    _reset_module_state(monkeypatch, {"STRIDE_AUTH_PUBLIC_KEY_PATH": str(path)})
    from stride_server.bearer import _load_public_key
    assert _load_public_key() == public_pem
