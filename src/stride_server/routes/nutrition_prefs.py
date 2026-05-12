"""Nutrition preferences endpoints — GET/PUT /api/users/me/nutrition-prefs."""

from __future__ import annotations

import logging
import re
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

_MAX_HISTORY = 5
_MAX_ALLERGIES = 20
_MAX_ALLERGY_LEN = 50


def _validate_uuid(uuid: str) -> str:
    if not _UUID4_RE.match(uuid or ""):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid user identifier",
        )
    return uuid


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _prefs_path(uuid: str) -> str:
    _validate_uuid(uuid)
    return f"{uuid}/nutrition_prefs.json"


def _read_store(uuid: str) -> dict[str, Any]:
    item = read_json(_prefs_path(uuid))
    if item is None:
        return {"current": None, "history": []}
    data, source = item
    if isinstance(data, dict):
        logger.info("nutrition_prefs read user=%s source=%s", uuid, source)
        return data
    logger.warning(
        "nutrition_prefs read ignored non-object JSON for user=%s source=%s", uuid, source
    )
    return {"current": None, "history": []}


def _write_store(uuid: str, store: dict[str, Any]) -> None:
    source = write_json(_prefs_path(uuid), store)
    logger.info("nutrition_prefs write user=%s source=%s", uuid, source)


# ── Pydantic model ────────────────────────────────────────────────────────────

class NutritionPrefs(BaseModel):
    enabled: bool
    diet_type: Literal["none", "vegetarian", "halal", "other"]
    allergies: list[str]                       # max 20
    goal: Literal["gain_muscle", "fat_loss", "maintain", "race"]
    bmr_kcal: float | None = None              # auto-compute if None
    tdee_kcal: float | None = None
    macro_protein_pct: float                   # 0-100
    macro_carb_pct: float
    macro_fat_pct: float
    created_at: str | None = None
    updated_at: str | None = None

    @model_validator(mode="after")
    def _validate_fields(self) -> "NutritionPrefs":
        # allergies length
        if len(self.allergies) > _MAX_ALLERGIES:
            raise ValueError(f"allergies must have at most {_MAX_ALLERGIES} items")

        # each allergy string length
        for allergy in self.allergies:
            if len(allergy) > _MAX_ALLERGY_LEN:
                raise ValueError(
                    f"each allergy string must be at most {_MAX_ALLERGY_LEN} characters"
                )

        # macro percentages must sum to 100 ±1
        macro_sum = self.macro_protein_pct + self.macro_carb_pct + self.macro_fat_pct
        if abs(macro_sum - 100.0) > 1.0:
            raise ValueError(
                f"macro_protein_pct + macro_carb_pct + macro_fat_pct must sum to 100 ±1, got {macro_sum}"
            )

        return self


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/api/users/me/nutrition-prefs")
def get_nutrition_prefs(
    payload: dict = Depends(require_bearer),
) -> NutritionPrefs:
    """Return the current nutrition preferences, or 404 if none exist."""
    uuid = _validate_uuid(payload["sub"])

    store = _read_store(uuid)
    current = store.get("current")
    if current is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No nutrition preferences found",
        )
    return NutritionPrefs(**current)


@router.put("/api/users/me/nutrition-prefs")
def upsert_nutrition_prefs(
    body: NutritionPrefs,
    payload: dict = Depends(require_bearer),
) -> NutritionPrefs:
    """Upsert nutrition preferences for the authenticated user."""
    uuid = _validate_uuid(payload["sub"])

    store = _read_store(uuid)

    now = _utcnow_iso()
    prefs_data = body.model_dump()

    # Move the current prefs to history before replacing
    if store.get("current") is not None:
        history: list[dict[str, Any]] = store.get("history") or []
        history.insert(0, store["current"])
        store["history"] = history[:_MAX_HISTORY]
        prefs_data["created_at"] = store["current"].get("created_at", now)
    else:
        prefs_data["created_at"] = now

    prefs_data["updated_at"] = now

    store["current"] = prefs_data
    _write_store(uuid, store)

    return NutritionPrefs(**prefs_data)
