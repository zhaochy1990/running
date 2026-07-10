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
    from stride_server.config import clear_server_config_cache

    clear_server_config_cache()
    monkeypatch.setattr(bearer, "_cached_public_key", None)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for key in (
        "STRIDE_AUTH_PUBLIC_KEY_PEM",
        "STRIDE_AUTH_PUBLIC_KEY_PATH",
        "STRIDE_AUTH_ISSUER",
        "STRIDE_AUTH_AUDIENCE",
        "STRIDE_AUTH_ALLOW_INSECURE_WITHOUT_KEY",
        "STRIDE_CONFIG_ENV",
        "STRIDE_ENV",
    ):
        monkeypatch.delenv(key, raising=False)
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    clear_server_config_cache()


def test_open_mode_when_key_unset(monkeypatch):
    _reset_module_state(monkeypatch, {"STRIDE_CONFIG_ENV": "local"})
    from stride_server.bearer import require_bearer
    claims = require_bearer(authorization=None)
    assert claims == {"sub": "anonymous", "role": "anonymous"}


def test_open_mode_decodes_present_bearer_without_verifying_signature(monkeypatch, rsa_keypair):
    private_pem, _ = rsa_keypair
    _reset_module_state(monkeypatch, {"STRIDE_CONFIG_ENV": "local"})
    from stride_server.bearer import require_bearer

    token = _issue(
        private_pem,
        sub="550e8400-e29b-41d4-a716-446655440000",
        role="user",
    )

    claims = require_bearer(authorization=f"Bearer {token}")

    assert claims["sub"] == "550e8400-e29b-41d4-a716-446655440000"
    assert claims["role"] == "user"


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


def test_load_public_key_cache_tracks_env_key_material(monkeypatch) -> None:
    _reset_module_state(monkeypatch, {"STRIDE_AUTH_PUBLIC_KEY_PEM": "pem-one"})
    from stride_server.bearer import _load_public_key
    from stride_server.config import clear_server_config_cache

    assert _load_public_key() == "pem-one"

    monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", "pem-two")
    clear_server_config_cache()

    assert _load_public_key() == "pem-two"


def test_is_dev_mode_no_arg_treats_default_env_as_dev(monkeypatch) -> None:
    _reset_module_state(monkeypatch)
    from stride_server.bearer import is_dev_mode

    assert is_dev_mode() is True


def test_load_public_key_from_config_prefers_inline_pem() -> None:
    from stride_server.bearer import load_public_key_from_config
    from stride_server.config.models import AuthConfig

    cfg = AuthConfig(public_key_pem="pem-inline", public_key_path="missing.pem")

    assert load_public_key_from_config(cfg) == "pem-inline"


def test_is_dev_mode_uses_config_env() -> None:
    from stride_server.bearer import is_dev_mode
    from stride_server.config.models import ServerConfig

    assert is_dev_mode(ServerConfig.default(env="dev")) is True
    assert is_dev_mode(ServerConfig.default(env="local")) is True
    assert is_dev_mode(ServerConfig.default(env="default")) is True
    assert is_dev_mode(ServerConfig.default(env="prod")) is False
