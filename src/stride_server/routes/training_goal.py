"""Training goal endpoints — POST/GET/PUT /api/users/me/training-goal."""

from __future__ import annotations

import logging
import re
import uuid as _uuid_mod
from datetime import date, datetime, timezone

from stride_core.timefmt import today_shanghai
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, model_validator

from ..bearer import require_bearer
from ..content_store import read_json, write_json

logger = logging.getLogger(__name__)

router = APIRouter()

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)

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


def _goal_path(uuid: str) -> str:
    _validate_uuid(uuid)
    return f"{uuid}/training_goal.json"


def _read_store(uuid: str) -> dict[str, Any]:
    item = read_json(_goal_path(uuid))
    if item is None:
        return {"current": None, "history": []}
    data, source = item
    if isinstance(data, dict):
        logger.info("training_goal read user=%s source=%s", uuid, source)
        return data
    logger.warning(
        "training_goal read ignored non-object JSON for user=%s source=%s", uuid, source
    )
    return {"current": None, "history": []}


def _write_store(uuid: str, store: dict[str, Any]) -> None:
    source = write_json(_goal_path(uuid), store)
    logger.info("training_goal write user=%s source=%s", uuid, source)


# ── Pydantic model ────────────────────────────────────────────────────────────

class TrainingGoal(BaseModel):
    goal_id: str | None = None
    type: Literal["race", "pb", "fat_loss", "health", "maintain"]
    race_date: str | None = None          # YYYY-MM-DD, required when type=race
    race_distance: Literal["5K", "10K", "HM", "FM", "trail"] | None = None  # required when type=race
    race_name: str | None = None          # 目标赛事名称, e.g. "2026 上海马拉松"; optional
    target_finish_time: str | None = None  # H:MM:SS; None = 仅完赛即可 (finish-only)
    weekly_training_days: int             # 3-6
    # Optional: the S1 season-plan setup form does not collect these (the
    # generator degrades gracefully when absent). The richer onboarding flow
    # still supplies them. ``available_time_slots`` defaults to empty rather
    # than being required-non-empty so the S1 POST does not 422.
    available_time_slots: list[Literal["morning", "noon", "evening"]] = Field(
        default_factory=list
    )
    strength_willingness: Literal["yes", "no", "conditional"] | None = None
    created_at: str | None = None
    updated_at: str | None = None

    @model_validator(mode="after")
    def _validate_race_fields(self) -> "TrainingGoal":
        if self.type == "race":
            if not self.race_date:
                raise ValueError("race_date is required when type is 'race'")
            if not self.race_distance:
                raise ValueError("race_distance is required when type is 'race'")
            # Validate date format and that it is in the future
            try:
                rd = date.fromisoformat(self.race_date)
            except ValueError:
                raise ValueError("race_date must be a valid YYYY-MM-DD date")
            if rd <= today_shanghai():
                raise ValueError("race_date must be a future date")

        if not (3 <= self.weekly_training_days <= 6):
            raise ValueError("weekly_training_days must be between 3 and 6")

        return self


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/api/users/me/training-goal", status_code=status.HTTP_201_CREATED)
def create_training_goal(
    body: TrainingGoal,
    payload: dict = Depends(require_bearer),
) -> TrainingGoal:
    """Create a new training goal for the authenticated user."""
    uuid = _validate_uuid(payload["sub"])

    store = _read_store(uuid)

    now = _utcnow_iso()
    goal_data = body.model_dump()
    goal_data["goal_id"] = str(_uuid_mod.uuid4())
    goal_data["created_at"] = now
    goal_data["updated_at"] = now

    # Move the current goal to history before replacing
    if store.get("current") is not None:
        history: list[dict[str, Any]] = store.get("history") or []
        history.insert(0, store["current"])
        store["history"] = history[:_MAX_HISTORY]

    store["current"] = goal_data
    _write_store(uuid, store)

    return TrainingGoal(**goal_data)


@router.get("/api/users/me/training-goal")
def get_training_goal(
    payload: dict = Depends(require_bearer),
) -> TrainingGoal:
    """Return the current active training goal, or 404 if none exists."""
    uuid = _validate_uuid(payload["sub"])

    store = _read_store(uuid)
    current = store.get("current")
    if current is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No training goal found",
        )
    return TrainingGoal(**current)


@router.put("/api/users/me/training-goal")
def update_training_goal(
    body: TrainingGoal,
    payload: dict = Depends(require_bearer),
) -> TrainingGoal:
    """Update the current training goal. goal_id must be provided and must match."""
    uuid = _validate_uuid(payload["sub"])

    if not body.goal_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="goal_id is required for PUT",
        )

    store = _read_store(uuid)
    current = store.get("current")
    if current is None or current.get("goal_id") != body.goal_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Training goal '{body.goal_id}' not found",
        )

    now = _utcnow_iso()
    goal_data = body.model_dump()
    goal_data["created_at"] = current.get("created_at", now)
    goal_data["updated_at"] = now

    store["current"] = goal_data
    _write_store(uuid, store)

    return TrainingGoal(**goal_data)
