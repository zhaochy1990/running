"""Notification settings routes — device registration + preferences.

Per the storage scope rule (CLAUDE.md): notification data is NOT watch-synced,
so it lives in Azure Table Storage (see ``stride_server.notifications.store``),
not the per-user SQLite DB.

All routes target the *caller* (JWT ``sub``), not a path-bound user. So they
sit under ``/api/users/me/...`` and use ``require_bearer`` directly.
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..bearer import require_bearer
from ..notifications import store as nstore

logger = logging.getLogger(__name__)
router = APIRouter()

_REG_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{8,200}$")
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _caller_id(claims: dict) -> str:
    sub = claims.get("sub")
    if not isinstance(sub, str):
        raise HTTPException(status_code=401, detail="invalid token sub")
    return sub


# ── Device registration ────────────────────────────────────────────────────


class RegisterDeviceBody(BaseModel):
    registration_id: str = Field(..., min_length=8, max_length=200)
    platform: str = Field(..., pattern=r"^(android|ios)$")
    app_version: str | None = Field(default=None, max_length=64)


@router.post("/api/users/me/devices")
def register_device(
    body: RegisterDeviceBody,
    claims: dict = Depends(require_bearer),
):
    if not _REG_ID_RE.match(body.registration_id):
        raise HTTPException(status_code=422, detail="invalid registration_id")
    user_id = _caller_id(claims)
    try:
        nstore.upsert_device(
            user_id,
            body.registration_id,
            platform=body.platform,
            app_version=body.app_version,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    logger.info(
        "Device registered for user=%s platform=%s",
        user_id[:8], body.platform,
    )
    return {"registered": True, "registration_id": body.registration_id}


@router.delete("/api/users/me/devices/{registration_id}")
def unregister_device(
    registration_id: str,
    claims: dict = Depends(require_bearer),
):
    if not _REG_ID_RE.match(registration_id):
        raise HTTPException(status_code=422, detail="invalid registration_id")
    user_id = _caller_id(claims)
    try:
        removed = nstore.delete_device(user_id, registration_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"unregistered": removed}


# ── Preferences ────────────────────────────────────────────────────────────


class PrefsBody(BaseModel):
    likes_enabled: bool | None = None
    plan_reminder_enabled: bool | None = None
    plan_reminder_time: str | None = None


@router.get("/api/users/me/notification-prefs")
def get_prefs(claims: dict = Depends(require_bearer)):
    user_id = _caller_id(claims)
    return nstore.get_prefs(user_id)


@router.patch("/api/users/me/notification-prefs")
def patch_prefs(
    body: PrefsBody,
    claims: dict = Depends(require_bearer),
):
    user_id = _caller_id(claims)
    if body.plan_reminder_time is not None and not _TIME_RE.match(body.plan_reminder_time):
        raise HTTPException(status_code=422, detail="plan_reminder_time must be HH:MM")
    return nstore.update_prefs(
        user_id,
        likes_enabled=body.likes_enabled,
        plan_reminder_enabled=body.plan_reminder_enabled,
        plan_reminder_time=body.plan_reminder_time,
    )
