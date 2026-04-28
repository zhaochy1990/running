"""Client-side auth helpers for the STRIDE CLI.

Stores tokens obtained from the in-house auth-service (Rust/Axum) at
``data/{user_id}/auth.json`` and refreshes them transparently when a call
is about to hit an expired access token.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import httpx

from stride_core.db import USER_DATA_DIR


def auth_path(profile: str) -> Path:
    return USER_DATA_DIR / profile / "auth.json"


def load_token(profile: str) -> dict[str, Any] | None:
    path = auth_path(profile)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def save_token(profile: str, data: dict[str, Any]) -> None:
    path = auth_path(profile)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def clear_token(profile: str) -> bool:
    path = auth_path(profile)
    if path.exists():
        path.unlink()
        return True
    return False


def login(auth_url: str, client_id: str, email: str, password: str) -> dict[str, Any]:
    """POST /api/auth/login and return the full token payload."""
    resp = httpx.post(
        f"{auth_url.rstrip('/')}/api/auth/login",
        headers={"X-Client-Id": client_id},
        json={"email": email, "password": password},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    return {
        "access_token": body["access_token"],
        "refresh_token": body["refresh_token"],
        "token_type": body.get("token_type", "Bearer"),
        "expires_at": int(time.time()) + int(body.get("expires_in", 3600)),
        "auth_url": auth_url,
        "client_id": client_id,
        "email": email,
    }


def refresh(token: dict[str, Any]) -> dict[str, Any]:
    """POST /api/auth/refresh and return a new token payload."""
    resp = httpx.post(
        f"{token['auth_url'].rstrip('/')}/api/auth/refresh",
        headers={"X-Client-Id": token["client_id"]},
        json={"refresh_token": token["refresh_token"]},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    token = dict(token)
    token.update(
        {
            "access_token": body["access_token"],
            "refresh_token": body.get("refresh_token", token["refresh_token"]),
            "expires_at": int(time.time()) + int(body.get("expires_in", 3600)),
        }
    )
    return token


def ensure_fresh(profile: str, skew_seconds: int = 60) -> dict[str, Any] | None:
    """Load the stored token; refresh it if it expires within ``skew_seconds``.

    Returns the (possibly refreshed) token, or None if no token is stored.
    """
    token = load_token(profile)
    if token is None:
        return None
    if token.get("expires_at", 0) > time.time() + skew_seconds:
        return token
    if not token.get("refresh_token"):
        return token
    token = refresh(token)
    save_token(profile, token)
    return token


def bearer_header(profile: str) -> dict[str, str]:
    """Return an Authorization header dict, or {} if no token is stored."""
    token = ensure_fresh(profile)
    if token is None:
        return {}
    return {"Authorization": f"{token['token_type']} {token['access_token']}"}
