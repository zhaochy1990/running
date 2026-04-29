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
  POST   /api/teams/{team_id}/transfer-owner — owner transfers ownership
  DELETE /api/teams/{team_id}             — owner dissolves team
  GET    /api/teams/{team_id}/members     — list members
  GET    /api/teams/{team_id}/feed        — recent activities across members
  GET    /api/users/me/teams              — caller's teams

Auth: relies on require_bearer at the router level (wired in app.py).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import sqlite3
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query

from stride_core.db import USER_DATA_DIR, Database
from stride_core.models import pace_str
from stride_core.source import DataSource

from .. import auth_service_client as auth_client
from ..bearer import require_bearer
from ..content_store import read_json
from ..deps import format_duration, get_source

logger = logging.getLogger(__name__)

router = APIRouter()

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def _stride_display_name(user_id: str) -> str | None:
    """Return ``display_name`` from the STRIDE profile JSON if present.

    Returns None when the UUID is malformed, the profile file is missing,
    JSON parsing fails, or ``display_name`` is empty/whitespace.
    """
    if not _UUID4_RE.match(user_id or ""):
        return None
    try:
        item = read_json(f"{user_id}/profile.json")
    except ValueError as exc:
        logger.warning("teams: cannot read profile for %s: %s", user_id, exc)
        return None
    if item is None:
        profile_path = USER_DATA_DIR / user_id / "profile.json"
        if not profile_path.exists():
            return None
        try:
            data = json.loads(profile_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            logger.warning("teams: cannot read profile for %s: %s", user_id, exc)
            return None
        source = "file"
    else:
        data, source = item
    logger.info("teams: profile read for %s source=%s", user_id, source)
    name = data.get("display_name") if isinstance(data, dict) else None
    if isinstance(name, str) and name.strip():
        return name.strip()
    return None


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


@router.delete("/api/teams/{team_id}")
async def delete_team(
    team_id: str,
    authorization: str | None = Header(default=None),
    _claims: dict = Depends(require_bearer),
):
    try:
        await auth_client.delete_team(_bearer(authorization), team_id)
    except auth_client.AuthServiceError as exc:
        raise _surface_auth_service_error(exc) from exc
    except auth_client.AuthServiceUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"auth-service unavailable: {exc}") from exc
    return {"status": "deleted"}


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


@router.post("/api/teams/{team_id}/transfer-owner")
async def transfer_team_owner(
    team_id: str,
    payload: dict = Body(...),
    authorization: str | None = Header(default=None),
    _claims: dict = Depends(require_bearer),
):
    new_owner_user_id = payload.get("new_owner_user_id")
    if not isinstance(new_owner_user_id, str) or not _UUID4_RE.match(new_owner_user_id):
        raise HTTPException(status_code=422, detail="new_owner_user_id must be a user UUID")

    try:
        return await auth_client.transfer_team_owner(
            _bearer(authorization),
            team_id,
            new_owner_user_id,
        )
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
    enriched = []
    for m in members:
        if not isinstance(m, dict):
            continue
        user_id = m.get("user_id")
        stride_name = _stride_display_name(user_id) if isinstance(user_id, str) else None
        out = dict(m)
        # STRIDE-controlled displayName wins over auth-service ``name``.
        out["display_name"] = stride_name or m.get("display_name") or m.get("name")
        enriched.append(out)
    return {"members": enriched}


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


@router.get("/api/teams/{team_id}/activities/{user_id}/{label_id}")
async def team_activity_detail(
    team_id: str,
    user_id: str,
    label_id: str,
    authorization: str | None = Header(default=None),
    _claims: dict = Depends(require_bearer),
):
    """Activity detail in team context — bypasses the per-user path-verify
    guard by authorizing via team membership instead.

    Both the caller and ``user_id`` must be members of ``team_id`` (membership
    checked via auth-service). On success returns the same payload shape as
    ``GET /api/{user}/activities/{label_id}`` so the frontend can reuse the
    detail page.
    """
    from .activities import build_activity_detail

    members = await auth_client.list_members(_bearer(authorization), team_id)
    member_ids = {m.get("user_id") for m in members if m.get("user_id")}
    caller_id = _claims.get("sub")
    if caller_id not in member_ids:
        raise HTTPException(status_code=403, detail="Caller is not a member of this team")
    if user_id not in member_ids:
        raise HTTPException(status_code=404, detail="User is not in this team")

    db_path = USER_DATA_DIR / user_id / "coros.db"
    if not db_path.exists():
        raise HTTPException(status_code=404, detail="No data for this user")

    try:
        db = Database(db_path)
    except (sqlite3.Error, OSError) as exc:
        logger.warning("teams.activity_detail: cannot open db for %s: %s", user_id, exc)
        raise HTTPException(status_code=503, detail="Cannot open user database")

    try:
        result = build_activity_detail(db, label_id)
    finally:
        db.close()

    if result is None:
        raise HTTPException(status_code=404, detail="Activity not found")
    return result


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
        display_name = (
            _stride_display_name(user_id)
            or m.get("display_name")
            or m.get("name")
            or user_id
        )
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
# Sync all members' COROS data — any team member can trigger.
# ---------------------------------------------------------------------------


@router.post("/api/teams/{team_id}/sync-all")
async def sync_team_all(
    team_id: str,
    authorization: str | None = Header(default=None),
    source: DataSource = Depends(get_source),
    _claims: dict = Depends(require_bearer),
):
    """Run an incremental sync for every member of the team.

    Any team member may trigger this. Members without valid COROS credentials
    are silently skipped. Returns a per-member summary plus totals so the UI
    can render a "what changed" panel.
    """
    members = await auth_client.list_members(_bearer(authorization), team_id)
    member_ids = {m.get("user_id") for m in members if m.get("user_id")}
    caller_id = _claims.get("sub")
    if caller_id not in member_ids:
        raise HTTPException(status_code=403, detail="Caller is not a member of this team")

    results: list[dict[str, Any]] = []
    totals = {
        "members": 0,
        "synced": 0,
        "skipped": 0,
        "errors": 0,
        "new_activities": 0,
        "new_health": 0,
    }

    for m in members:
        user_id = m.get("user_id")
        if not user_id:
            continue
        totals["members"] += 1
        display_name = (
            _stride_display_name(user_id)
            or m.get("display_name")
            or m.get("name")
            or user_id
        )
        entry: dict[str, Any] = {
            "user_id": user_id,
            "display_name": display_name,
            "status": "skipped_no_auth",
            "new_activities": 0,
            "new_health": 0,
            "error": None,
        }
        try:
            if not source.is_logged_in(user_id):
                totals["skipped"] += 1
                results.append(entry)
                continue
            # sync_user is sync + network-bound; offload so we don't block the
            # event loop while syncing each member sequentially.
            sync_result = await asyncio.to_thread(source.sync_user, user_id, full=False)
            entry["status"] = "synced"
            entry["new_activities"] = sync_result.activities
            entry["new_health"] = sync_result.health
            totals["synced"] += 1
            totals["new_activities"] += sync_result.activities
            totals["new_health"] += sync_result.health
        except Exception as exc:  # noqa: BLE001 — surface any adapter failure
            logger.exception("teams.sync_all: sync failed for %s", user_id)
            entry["status"] = "error"
            entry["error"] = str(exc)[:200] or exc.__class__.__name__
            totals["errors"] += 1
        results.append(entry)

    return {
        "team_id": team_id,
        "results": results,
        "totals": totals,
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
