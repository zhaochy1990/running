"""Bearer JWT verification against the in-house auth-service.

The auth-service at ``C:\\Users\\zhaochaoyi\\workspace\\auth`` issues RS256
tokens with claims ``{sub, aud, iss, exp, iat, scopes, role}``. Because the
service does not expose a JWKS endpoint, STRIDE must be configured with
``auth.public_key_pem`` or ``auth.public_key_path``. Legacy environment
variables still map into those typed config fields.

Missing public-key configuration fails closed unless
``auth.allow_insecure_without_key`` is explicitly true for local development.
Production should configure a public key and fail closed otherwise.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import jwt
from fastapi import Depends, Header, HTTPException, Request, status

from stride_server.config import load_server_config
from stride_server.config.loader import resolve_config_env
from stride_server.config.models import AuthConfig, ServerConfig

logger = logging.getLogger(__name__)

_cached_public_key: str | None = None
_cached_public_key_cache_key: tuple[object, ...] | None = None
_warned_open = False


def is_dev_mode(config: ServerConfig | None = None) -> bool:
    """Return True for config environments that permit local fail-open auth."""
    env = config.env if config is not None else resolve_config_env()
    return env.lower() in {"dev", "local", "default"}


def load_public_key_from_config(config: AuthConfig) -> str | None:
    if config.public_key_pem:
        return config.public_key_pem
    if config.public_key_path:
        path = Path(config.public_key_path)
        if path.exists():
            return path.read_text(encoding="utf-8")
    return None


def _public_key_cache_key(config: AuthConfig) -> tuple[object, ...]:
    if config.public_key_pem:
        return ("pem", config.public_key_pem)
    if config.public_key_path:
        path = Path(config.public_key_path)
        try:
            stat = path.stat()
        except OSError:
            return ("path-missing", str(path))
        return ("path", str(path.resolve()), stat.st_mtime_ns, stat.st_size)
    return ("none",)


def _load_public_key() -> str | None:
    global _cached_public_key, _cached_public_key_cache_key
    auth_config = load_server_config().auth
    cache_key = _public_key_cache_key(auth_config)
    if _cached_public_key is not None and _cached_public_key_cache_key == cache_key:
        return _cached_public_key
    if _cached_public_key is not None and _cached_public_key_cache_key is None:
        return _cached_public_key
    key = load_public_key_from_config(auth_config)
    _cached_public_key = key
    _cached_public_key_cache_key = cache_key if key is not None else None
    return key


def _resolve_server_config(request: Request | None) -> ServerConfig:
    if request is not None:
        config = getattr(request.app.state, "config", None)
        if config is not None:
            return config
    return load_server_config()


def _warn_open_once() -> None:
    global _warned_open
    if not _warned_open:
        logger.warning(
            "STRIDE_AUTH_PUBLIC_KEY_PEM/PATH not configured — Bearer "
            "verification DISABLED. Write endpoints are open."
        )
        _warned_open = True


def require_bearer(
    request: Request = None,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """FastAPI dependency — verify Authorization Bearer against the auth-service.

    Returns the decoded claims on success. When the public key is not
    configured, returns a synthetic ``{"sub": "anonymous", "role": "anonymous"}``
    claims dict so downstream handlers can still run in dev mode.
    """
    cfg = _resolve_server_config(request)
    public_key = (
        load_public_key_from_config(cfg.auth)
        if request is not None and getattr(request.app.state, "config", None) is not None
        else _load_public_key()
    )
    if public_key is None:
        if cfg.auth.allow_insecure_without_key:
            _warn_open_once()
            return {"sub": "anonymous", "role": "anonymous"}
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer verification is not configured",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization[len("Bearer ") :].strip()

    issuer = cfg.auth.issuer
    audience = cfg.auth.audience or None

    try:
        claims = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            issuer=issuer,
            audience=audience,
            options={"verify_aud": audience is not None},
        )
    except jwt.InvalidTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    return claims


def current_user_id(payload: dict[str, Any]) -> str:
    """Return the JWT subject (user UUID) from a decoded claims dict."""
    return payload["sub"]


def verify_path_user(
    user: str,
    payload: dict[str, Any] = Depends(require_bearer),
) -> None:
    """FastAPI dependency — raise 403 when the path {user} != JWT sub.

    Use 403 (not 401) because the token itself is valid; the caller is
    authenticated but is trying to access a different user's resources.
    """
    if user != payload["sub"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: path user does not match token subject",
        )
