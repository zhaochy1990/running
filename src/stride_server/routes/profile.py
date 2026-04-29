"""Profile and onboarding-status endpoints."""

from __future__ import annotations

import logging
import re
from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..bearer import require_bearer
from ..content_store import read_json, write_json

router = APIRouter()
logger = logging.getLogger(__name__)

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def _validate_uuid(uuid: str) -> str:
    if not _UUID4_RE.match(uuid or ""):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid user identifier",
        )
    return uuid


def _profile_path(uuid: str) -> str:
    _validate_uuid(uuid)
    return f"{uuid}/profile.json"


def _onboarding_path(uuid: str) -> str:
    _validate_uuid(uuid)
    return f"{uuid}/onboarding.json"


def _read_profile(uuid: str) -> dict[str, Any]:
    item = read_json(_profile_path(uuid))
    if item is None:
        return {}
    data, source = item
    if isinstance(data, dict):
        logger.info("profile read user=%s source=%s", uuid, source)
        return data
    logger.warning("profile read ignored non-object JSON for user=%s source=%s", uuid, source)
    return {}


def _read_onboarding(uuid: str) -> dict[str, Any]:
    item = read_json(_onboarding_path(uuid))
    if item is not None:
        data, source = item
        if isinstance(data, dict):
            logger.info("onboarding read user=%s source=%s", uuid, source)
            return data
        logger.warning("onboarding read ignored non-object JSON for user=%s source=%s", uuid, source)
    return {
        "coros_ready": False,
        "profile_ready": False,
        "completed_at": None,
        "sync_state": None,
    }


def _write_state(relative_path: str, data: dict[str, Any]) -> None:
    source = write_json(relative_path, data)
    logger.info("profile state write path=%s source=%s", relative_path, source)


class ProfileIn(BaseModel):
    display_name: str = Field(..., min_length=1)
    dob: date
    sex: Literal["male", "female", "other"]
    height_cm: float = Field(..., gt=0)
    weight_kg: float = Field(..., gt=0)
    target_race: str = Field(..., min_length=1)
    target_distance: Literal["5K", "10K", "HM", "FM"]
    target_race_date: date
    target_time: str = Field(..., pattern=r"^\d{1,2}:\d{2}:\d{2}$")
    pbs: dict[str, str] | None = None
    weekly_mileage_km: float | None = None
    constraints: str | None = None


class ProfilePatch(BaseModel):
    """All fields optional — used by PATCH for post-onboarding edits."""

    display_name: str | None = Field(default=None, min_length=1)
    dob: date | None = None
    sex: Literal["male", "female", "other"] | None = None
    height_cm: float | None = Field(default=None, gt=0)
    weight_kg: float | None = Field(default=None, gt=0)
    target_race: str | None = Field(default=None, min_length=1)
    target_distance: Literal["5K", "10K", "HM", "FM"] | None = None
    target_race_date: date | None = None
    target_time: str | None = Field(default=None, pattern=r"^\d{1,2}:\d{2}:\d{2}$")
    pbs: dict[str, str] | None = None
    weekly_mileage_km: float | None = Field(default=None, ge=0)
    constraints: str | None = None


@router.get("/api/users/me/profile")
def get_profile(payload: dict = Depends(require_bearer)):
    uuid = payload["sub"]
    profile = _read_profile(uuid)
    onboarding = _read_onboarding(uuid)
    return {
        "id": uuid,
        "display_name": profile.get("display_name"),
        "profile": profile,
        "onboarding": onboarding,
    }


@router.post("/api/users/me/profile")
def post_profile(body: ProfileIn, payload: dict = Depends(require_bearer)):
    uuid = payload["sub"]

    profile_data = body.model_dump()

    _write_state(_profile_path(uuid), profile_data)

    onboarding = _read_onboarding(uuid)
    onboarding["profile_ready"] = True
    _write_state(_onboarding_path(uuid), onboarding)

    return {"ok": True}


@router.patch("/api/users/me/profile")
def patch_profile(body: ProfilePatch, payload: dict = Depends(require_bearer)):
    """Partial profile update for post-onboarding edits.

    Reads the existing profile.json, merges any non-None fields from the
    request, and writes back. Unspecified fields are preserved.
    """
    uuid = payload["sub"]

    patch = body.model_dump(exclude_unset=True)
    if not patch:
        return {"ok": True, "profile": _read_profile(uuid)}

    existing = _read_profile(uuid)
    merged = {**existing, **patch}

    _write_state(_profile_path(uuid), merged)

    return {
        "ok": True,
        "id": uuid,
        "display_name": merged.get("display_name"),
        "profile": merged,
    }
