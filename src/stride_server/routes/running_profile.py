"""Running profile endpoints — POST/GET/PUT /api/users/me/running-profile."""

from __future__ import annotations

import logging
import re
import uuid as _uuid_mod
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, model_validator

from ..bearer import require_bearer
from ..content_store import read_json, write_json

logger = logging.getLogger(__name__)

router = APIRouter()

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_TIME_RE = re.compile(r"^\d+:\d{2}:\d{2}$")

_MAX_HISTORY = 5


def _validate_uuid(uuid: str) -> str:
    if not _UUID4_RE.match(uuid or ""):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid user identifier",
        )
    return uuid


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _profile_path(uuid: str) -> str:
    _validate_uuid(uuid)
    return f"{uuid}/running_profile.json"


def _read_store(uuid: str) -> dict[str, Any]:
    item = read_json(_profile_path(uuid))
    if item is None:
        return {"current": None, "history": []}
    data, source = item
    if isinstance(data, dict):
        logger.info("running_profile read user=%s source=%s", uuid, source)
        return data
    logger.warning(
        "running_profile read ignored non-object JSON for user=%s source=%s", uuid, source
    )
    return {"current": None, "history": []}


def _write_store(uuid: str, store: dict[str, Any]) -> None:
    source = write_json(_profile_path(uuid), store)
    logger.info("running_profile write user=%s source=%s", uuid, source)


# ── Pydantic models ───────────────────────────────────────────────────────────

class PB(BaseModel):
    distance: Literal["5K", "10K", "HM", "FM"]
    time: str  # H:MM:SS

    @model_validator(mode="after")
    def _validate_time_format(self) -> "PB":
        if not _TIME_RE.match(self.time):
            raise ValueError("time must be in H:MM:SS format")
        return self


class RunningProfile(BaseModel):
    profile_id: str | None = None
    running_age: Literal["lt_6m", "6m_1y", "1y_3y", "3y_plus"]
    current_weekly_km: Literal["lt_20", "20_40", "40_60", "60_plus"]
    pbs: list[PB]         # 0–4 entries
    injuries: list[str]   # multi-select tags, may include "none"
    created_at: str | None = None
    updated_at: str | None = None

    @model_validator(mode="after")
    def _validate_profile(self) -> "RunningProfile":
        # pbs: distance must not be duplicated
        distances = [pb.distance for pb in self.pbs]
        if len(distances) != len(set(distances)):
            raise ValueError("pbs cannot contain duplicate distances")

        # injuries: "none" must not coexist with other tags
        if "none" in self.injuries and len(self.injuries) > 1:
            raise ValueError(
                "injuries cannot contain 'none' together with other injury tags"
            )

        return self


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/api/users/me/running-profile", status_code=status.HTTP_201_CREATED)
def create_running_profile(
    body: RunningProfile,
    payload: dict = Depends(require_bearer),
) -> RunningProfile:
    """Create a new running profile for the authenticated user."""
    uuid = _validate_uuid(payload["sub"])

    store = _read_store(uuid)

    now = _utcnow_iso()
    profile_data = body.model_dump()
    profile_data["profile_id"] = str(_uuid_mod.uuid4())
    profile_data["created_at"] = now
    profile_data["updated_at"] = now

    # Move the current profile to history before replacing
    if store.get("current") is not None:
        history: list[dict[str, Any]] = store.get("history") or []
        history.insert(0, store["current"])
        store["history"] = history[:_MAX_HISTORY]

    store["current"] = profile_data
    _write_store(uuid, store)

    return RunningProfile(**profile_data)


@router.get("/api/users/me/running-profile")
def get_running_profile(
    payload: dict = Depends(require_bearer),
) -> RunningProfile:
    """Return the current running profile, or 404 if none exists."""
    uuid = _validate_uuid(payload["sub"])

    store = _read_store(uuid)
    current = store.get("current")
    if current is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No running profile found",
        )
    return RunningProfile(**current)


@router.put("/api/users/me/running-profile")
def update_running_profile(
    body: RunningProfile,
    payload: dict = Depends(require_bearer),
) -> RunningProfile:
    """Update the current running profile. profile_id must be provided and must match."""
    uuid = _validate_uuid(payload["sub"])

    if not body.profile_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="profile_id is required for PUT",
        )

    store = _read_store(uuid)
    current = store.get("current")
    if current is None or current.get("profile_id") != body.profile_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Running profile '{body.profile_id}' not found",
        )

    now = _utcnow_iso()
    profile_data = body.model_dump()
    profile_data["created_at"] = current.get("created_at", now)
    profile_data["updated_at"] = now

    store["current"] = profile_data
    _write_store(uuid, store)

    return RunningProfile(**profile_data)
