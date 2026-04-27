"""Bearer JWT verification against the in-house auth-service.

The auth-service at ``C:\\Users\\zhaochaoyi\\workspace\\auth`` issues RS256
tokens with claims ``{sub, aud, iss, exp, iat, scopes, role}``. Because the
service does not expose a JWKS endpoint, the public key must be supplied to
STRIDE out-of-band via env vars:

  - ``STRIDE_AUTH_PUBLIC_KEY_PEM``  — inline PEM (preferred for container apps)
  - ``STRIDE_AUTH_PUBLIC_KEY_PATH`` — path to PEM file (preferred for local dev)

Optional:
  - ``STRIDE_AUTH_ISSUER``         — expected ``iss`` claim (default ``auth-service``)
  - ``STRIDE_AUTH_AUDIENCE``       — if set, ``aud`` must match (the STRIDE client_id)

When neither public-key env var is set, verification is **bypassed** with a
one-time warning log. This keeps local dev and the current production deploy
working out-of-the-box; set the env vars to enforce auth.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import jwt
from fastapi import Depends, Header, HTTPException, status

logger = logging.getLogger(__name__)

_cached_public_key: str | None = None
_warned_open = False


def is_dev_mode() -> bool:
    """Return True when STRIDE_ENV is set to 'dev' (case-insensitive)."""
    return os.environ.get("STRIDE_ENV", "").lower() == "dev"


def _load_public_key() -> str | None:
    global _cached_public_key
    if _cached_public_key is not None:
        return _cached_public_key
    pem = os.environ.get("STRIDE_AUTH_PUBLIC_KEY_PEM")
    if pem:
        _cached_public_key = pem
        return pem
    path = os.environ.get("STRIDE_AUTH_PUBLIC_KEY_PATH")
    if path and Path(path).exists():
        _cached_public_key = Path(path).read_text()
        return _cached_public_key
    return None


def _warn_open_once() -> None:
    global _warned_open
    if not _warned_open:
        logger.warning(
            "STRIDE_AUTH_PUBLIC_KEY_PEM/PATH not configured — Bearer "
            "verification DISABLED. Write endpoints are open."
        )
        _warned_open = True


def require_bearer(
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """FastAPI dependency — verify Authorization Bearer against the auth-service.

    Returns the decoded claims on success. When the public key is not
    configured, returns a synthetic ``{"sub": "anonymous", "role": "anonymous"}``
    claims dict so downstream handlers can still run in dev mode.
    """
    public_key = _load_public_key()
    if public_key is None:
        _warn_open_once()
        return {"sub": "anonymous", "role": "anonymous"}

    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization[len("Bearer ") :].strip()

    issuer = os.environ.get("STRIDE_AUTH_ISSUER", "auth-service")
    audience = os.environ.get("STRIDE_AUTH_AUDIENCE")

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
