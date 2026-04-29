"""Thin httpx client for the auth-service team endpoints.

The auth-service (separate Rust/Axum repo at C:\\Users\\zhaochaoyi\\workspace\\auth)
owns the canonical team data — Teams, TeamMembership rows, and team query endpoints
all live there. STRIDE consumes those endpoints to render team UIs and to drive
the cross-user activity feed (see routes/teams.py).

This module forwards the caller's existing Bearer token; the auth-service uses
it to identify the current user just like STRIDE itself does. No service-to-service
credential is needed because every STRIDE request is already an authenticated
end-user request.

Env vars:
  - STRIDE_AUTH_URL    : base URL of the auth-service (e.g. https://auth-backend...azurecontainerapps.io)
  - STRIDE_CLIENT_ID   : (optional, currently unused here) the STRIDE client_id

If STRIDE_AUTH_URL is unset OR the auth-service is unreachable / returns 5xx,
client methods raise AuthServiceUnavailable and the route layer surfaces a
graceful empty result so the UI doesn't hard-crash. This is the v1 fallback
behaviour for the period before the auth-service ships team endpoints.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT_S = 5.0


class AuthServiceUnavailable(RuntimeError):
    """Auth-service is not configured, unreachable, or returned a 5xx."""


class AuthServiceError(RuntimeError):
    """Auth-service returned a 4xx error. Carries status + detail for surfacing."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(f"auth-service {status_code}: {detail}")
        self.status_code = status_code
        self.detail = detail


def _base_url() -> str:
    url = os.environ.get("STRIDE_AUTH_URL", "").strip()
    if not url:
        raise AuthServiceUnavailable("STRIDE_AUTH_URL not configured")
    return url.rstrip("/")


def _headers(bearer: str | None) -> dict[str, str]:
    h = {"Accept": "application/json"}
    if bearer:
        h["Authorization"] = f"Bearer {bearer}"
    return h


async def _request(
    method: str,
    path: str,
    *,
    bearer: str | None,
    json_body: Any = None,
) -> Any:
    """Issue an authenticated request to the auth-service.

    Raises AuthServiceUnavailable on network / 5xx errors and
    AuthServiceError(status, detail) on 4xx errors.
    """
    base = _base_url()
    url = f"{base}{path}"
    try:
        async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT_S) as client:
            resp = await client.request(method, url, headers=_headers(bearer), json=json_body)
    except httpx.HTTPError as exc:
        logger.warning("auth-service %s %s failed: %s", method, path, exc)
        raise AuthServiceUnavailable(str(exc)) from exc

    if resp.status_code >= 500:
        raise AuthServiceUnavailable(f"auth-service {resp.status_code}: {resp.text[:200]}")
    if resp.status_code >= 400:
        try:
            detail = resp.json()
        except Exception:
            detail = resp.text
        raise AuthServiceError(resp.status_code, str(detail))

    if not resp.content:
        return None
    return resp.json()


# ---------------------------------------------------------------------------
# Public API — one function per endpoint.
# ---------------------------------------------------------------------------


async def list_teams(bearer: str | None) -> list[dict[str, Any]]:
    """GET /api/teams — list all open teams. Returns [] on failure."""
    try:
        data = await _request("GET", "/api/teams", bearer=bearer)
    except AuthServiceUnavailable:
        return []
    if isinstance(data, dict) and "teams" in data:
        return list(data["teams"])
    if isinstance(data, list):
        return data
    return []


async def create_team(bearer: str | None, name: str, description: str | None = None) -> dict[str, Any]:
    body = {"name": name}
    if description is not None:
        body["description"] = description
    return await _request("POST", "/api/teams", bearer=bearer, json_body=body)


async def get_team(bearer: str | None, team_id: str) -> dict[str, Any] | None:
    try:
        return await _request("GET", f"/api/teams/{team_id}", bearer=bearer)
    except AuthServiceError as exc:
        if exc.status_code == 404:
            return None
        raise


async def join_team(bearer: str | None, team_id: str) -> dict[str, Any]:
    return await _request("POST", f"/api/teams/{team_id}/join", bearer=bearer)


async def leave_team(bearer: str | None, team_id: str) -> dict[str, Any]:
    return await _request("POST", f"/api/teams/{team_id}/leave", bearer=bearer)


async def transfer_team_owner(bearer: str | None, team_id: str, new_owner_user_id: str) -> dict[str, Any]:
    return await _request(
        "POST",
        f"/api/teams/{team_id}/transfer-owner",
        bearer=bearer,
        json_body={"new_owner_user_id": new_owner_user_id},
    )


async def delete_team(bearer: str | None, team_id: str) -> None:
    await _request("DELETE", f"/api/teams/{team_id}", bearer=bearer)


async def list_members(bearer: str | None, team_id: str) -> list[dict[str, Any]]:
    try:
        data = await _request("GET", f"/api/teams/{team_id}/members", bearer=bearer)
    except AuthServiceUnavailable:
        return []
    if isinstance(data, dict) and "members" in data:
        return list(data["members"])
    if isinstance(data, list):
        return data
    return []


async def list_my_teams(bearer: str | None) -> list[dict[str, Any]]:
    try:
        data = await _request("GET", "/api/users/me/teams", bearer=bearer)
    except AuthServiceUnavailable:
        return []
    if isinstance(data, dict) and "teams" in data:
        return list(data["teams"])
    if isinstance(data, list):
        return data
    return []


async def delete_my_account(bearer: str | None) -> None:
    await _request("DELETE", "/api/users/me", bearer=bearer)
