"""Team routes — proxy to auth-service for membership data, join with local
SQLite activity DBs to surface a cross-user feed.

The auth-service owns Teams and TeamMembership. STRIDE owns the per-user
activity SQLite DBs. The feed endpoint joins the two: it asks auth-service
who is in the team, then reads each member's data/{user_id}/coros.db for recent
activities.

Routes:
  GET    /api/teams                       — list open teams
  POST   /api/teams                       — create team (caller becomes owner)
  GET    /api/teams/{team_id}             — single team
  POST   /api/teams/{team_id}/join        — caller joins
  POST   /api/teams/{team_id}/leave       — caller leaves
  GET    /api/teams/{team_id}/members     — list members
  GET    /api/teams/{team_id}/feed        — recent activities across members
  GET    /api/users/me/teams              — caller's teams

Auth: relies on require_bearer at the router level (wired in app.py).
"""

from __future__ import annotations

import logging
import sqlite3
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query

from stride_core.db import USER_DATA_DIR, Database
from stride_core.models import pace_str

from .. import auth_service_client as auth_client
from ..bearer import require_bearer
from ..deps import format_duration

logger = logging.getLogger(__name__)

router = APIRouter()


def _bearer(authorization: str | None) -> str | None:
    """Extract the raw token from an Authorization header, or None."""
    if not authorization:
        return None
    if authorization.lower().startswith("bearer "):
        return authorization[len("Bearer ") :].strip()
    return None


def _surface_auth_service_error(exc: auth_client.AuthServiceError) -> HTTPException:
    """Map auth-service 4xx into a STRIDE HTTPException, preserving status."""
    return HTTPException(status_code=exc.status_code, detail=exc.detail)


# ---------------------------------------------------------------------------
# List + create + detail
# ---------------------------------------------------------------------------


@router.get("/api/teams")
async def list_teams(
    authorization: str | None = Header(default=None),
    _claims: dict = Depends(require_bearer),
):
    teams = await auth_client.list_teams(_bearer(authorization))
    return {"teams": teams}


@router.post("/api/teams")
async def create_team(
    payload: dict = Body(...),
    authorization: str | None = Header(default=None),
    _claims: dict = Depends(require_bearer),
):
    name = payload.get("name")
    if not isinstance(name, str) or not name.strip():
        raise HTTPException(status_code=422, detail="name is required")
    description = payload.get("description")
    if description is not None and not isinstance(description, str):
        raise HTTPException(status_code=422, detail="description must be a string")

    try:
        team = await auth_client.create_team(_bearer(authorization), name.strip(), description)
    except auth_client.AuthServiceError as exc:
        raise _surface_auth_service_error(exc) from exc
    except auth_client.AuthServiceUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"auth-service unavailable: {exc}") from exc
    return team


@router.get("/api/teams/{team_id}")
async def get_team(
    team_id: str,
    authorization: str | None = Header(default=None),
    _claims: dict = Depends(require_bearer),
):
    try:
        team = await auth_client.get_team(_bearer(authorization), team_id)
    except auth_client.AuthServiceError as exc:
        raise _surface_auth_service_error(exc) from exc
    except auth_client.AuthServiceUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"auth-service unavailable: {exc}") from exc
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")
    return team


# ---------------------------------------------------------------------------
# Membership: join / leave / members
# ---------------------------------------------------------------------------


@router.post("/api/teams/{team_id}/join")
async def join_team(
    team_id: str,
    authorization: str | None = Header(default=None),
    _claims: dict = Depends(require_bearer),
):
    try:
        return await auth_client.join_team(_bearer(authorization), team_id)
    except auth_client.AuthServiceError as exc:
        raise _surface_auth_service_error(exc) from exc
    except auth_client.AuthServiceUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"auth-service unavailable: {exc}") from exc


@router.post("/api/teams/{team_id}/leave")
async def leave_team(
    team_id: str,
    authorization: str | None = Header(default=None),
    _claims: dict = Depends(require_bearer),
):
    try:
        return await auth_client.leave_team(_bearer(authorization), team_id)
    except auth_client.AuthServiceError as exc:
        raise _surface_auth_service_error(exc) from exc
    except auth_client.AuthServiceUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"auth-service unavailable: {exc}") from exc


@router.get("/api/teams/{team_id}/members")
async def list_members(
    team_id: str,
    authorization: str | None = Header(default=None),
    _claims: dict = Depends(require_bearer),
):
    members = await auth_client.list_members(_bearer(authorization), team_id)
    return {"members": members}


# ---------------------------------------------------------------------------
# Cross-user activity feed — the core team feature.
# ---------------------------------------------------------------------------


def _read_member_activities(user_id: str, limit_per_user: int, days: int) -> list[dict[str, Any]]:
    """Read recent activities from one member's local SQLite DB.

    Returns [] on any DB error (e.g. user has no STRIDE coros.db yet).
    """
    db_path = USER_DATA_DIR / user_id / "coros.db"
    if not db_path.exists():
        return []
    try:
        db = Database(db_path)
    except (sqlite3.Error, OSError) as exc:
        logger.warning("teams.feed: cannot open db for %s: %s", user_id, exc)
        return []

    try:
        rows = db.query(
            """SELECT label_id, name, sport_type, sport_name, date,
                distance_m, duration_s, avg_pace_s_km, avg_hr, max_hr,
                training_load, vo2max, train_type
            FROM activities
            WHERE date >= datetime('now', ? )
            ORDER BY date DESC
            LIMIT ?""",
            (f"-{int(days)} days", int(limit_per_user)),
        )
    except sqlite3.Error as exc:
        logger.warning("teams.feed: query failed for %s: %s", user_id, exc)
        return []
    finally:
        db.close()

    out = []
    for r in rows:
        d = dict(r)
        d["distance_km"] = round(d.get("distance_m") or 0, 2)
        d["duration_fmt"] = format_duration(d.get("duration_s"))
        d["pace_fmt"] = pace_str(d.get("avg_pace_s_km")) or "—"
        out.append(d)
    return out


@router.get("/api/teams/{team_id}/feed")
async def team_feed(
    team_id: str,
    days: int = Query(30, ge=1, le=180),
    limit_per_user: int = Query(20, ge=1, le=100),
    authorization: str | None = Header(default=None),
    _claims: dict = Depends(require_bearer),
):
    """Strava-style activity feed for a team.

    Asks auth-service for the current member list, then iterates each member's
    local SQLite DB for recent activities. Tags each row with user_id +
    display_name and returns a unified date-sorted list.

    No per-activity privacy controls in v1 (Q2.2 = full visibility). If a member
    has no STRIDE DB yet, they're silently skipped.
    """
    members = await auth_client.list_members(_bearer(authorization), team_id)
    feed: list[dict[str, Any]] = []
    for m in members:
        user_id = m.get("user_id")
        if not user_id:
            continue
        display_name = m.get("name") or m.get("display_name") or user_id
        for act in _read_member_activities(user_id, limit_per_user, days):
            act["user_id"] = user_id
            act["display_name"] = display_name
            feed.append(act)

    feed.sort(key=lambda a: a.get("date") or "", reverse=True)
    return {
        "team_id": team_id,
        "member_count": len(members),
        "activities": feed,
    }


# ---------------------------------------------------------------------------
# Caller's own teams
# ---------------------------------------------------------------------------


@router.get("/api/users/me/teams")
async def my_teams(
    authorization: str | None = Header(default=None),
    _claims: dict = Depends(require_bearer),
):
    teams = await auth_client.list_my_teams(_bearer(authorization))
    return {"teams": teams}
