"""Nutrition meals endpoints — POST/GET /api/{user}/nutrition/meals.

Storage: JSON file at {user_id}/nutrition_meals.json (content_store).
Does NOT use SQLite — meals are not watch-synced data (CLAUDE.md storage rule).

Schema:
{
  "by_date": {
    "2026-05-12": [
      {"meal_id": "uuid", "meal_type": "breakfast", "items": [...],
       "notes": null, "created_at": "..."}
    ]
  }
}
"""

from __future__ import annotations

import logging
import uuid as _uuid_mod
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, field_validator, model_validator

from ..content_store import read_json, write_json

logger = logging.getLogger(__name__)

router = APIRouter()

_MEAL_STORE_PATH = "{user}/nutrition_meals.json"
_MAX_NOTES_LEN = 500


# ── Pydantic models ────────────────────────────────────────────────────────────

class FoodItem(BaseModel):
    name: str
    kcal: float
    protein_g: float
    carb_g: float
    fat_g: float

    @model_validator(mode="after")
    def _non_negative(self) -> "FoodItem":
        for field in ("kcal", "protein_g", "carb_g", "fat_g"):
            v = getattr(self, field)
            if v < 0:
                raise ValueError(f"{field} must be >= 0")
        return self


class MealCreateRequest(BaseModel):
    date: str
    meal_type: Literal["breakfast", "lunch", "dinner", "snack"]
    items: list[FoodItem]
    notes: str | None = None

    @field_validator("date")
    @classmethod
    def _validate_date(cls, v: str) -> str:
        import re
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
            raise ValueError("date must be YYYY-MM-DD")
        # Validate it's a real date
        from datetime import date as _date
        try:
            _date.fromisoformat(v)
        except ValueError:
            raise ValueError("date is not a valid calendar date")
        return v

    @field_validator("items")
    @classmethod
    def _non_empty_items(cls, v: list[FoodItem]) -> list[FoodItem]:
        if not v:
            raise ValueError("items must contain at least one entry")
        return v

    @field_validator("notes")
    @classmethod
    def _notes_length(cls, v: str | None) -> str | None:
        if v is not None and len(v) > _MAX_NOTES_LEN:
            raise ValueError(f"notes must be <= {_MAX_NOTES_LEN} characters")
        return v


# ── Helpers ────────────────────────────────────────────────────────────────────

def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _store_path(user: str) -> str:
    return f"{user}/nutrition_meals.json"


def _read_store(user: str) -> dict:
    result = read_json(_store_path(user))
    if result is None:
        return {"by_date": {}}
    data, source = result
    if not isinstance(data, dict) or "by_date" not in data:
        logger.warning("nutrition_meals: malformed store for user=%s source=%s", user, source)
        return {"by_date": {}}
    logger.info("nutrition_meals read user=%s source=%s", user, source)
    return data


def _write_store(user: str, store: dict) -> None:
    source = write_json(_store_path(user), store)
    logger.info("nutrition_meals write user=%s source=%s", user, source)


def _compute_totals(items: list[dict]) -> dict:
    totals: dict[str, float] = {"kcal": 0.0, "protein_g": 0.0, "carb_g": 0.0, "fat_g": 0.0}
    for item in items:
        for key in totals:
            totals[key] += item.get(key, 0.0)
    return {k: round(v, 2) for k, v in totals.items()}


def _daily_totals(meals: list[dict]) -> dict:
    all_items = [item for meal in meals for item in meal.get("items", [])]
    return _compute_totals(all_items)


def _meal_response(meal: dict) -> dict:
    return {
        "meal_id": meal["meal_id"],
        "meal_type": meal["meal_type"],
        "items": meal["items"],
        "totals": _compute_totals(meal["items"]),
        "notes": meal.get("notes"),
        "created_at": meal["created_at"],
    }


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("/api/{user}/nutrition/meals", status_code=status.HTTP_200_OK)
def create_meal(user: str, body: MealCreateRequest):
    """Append a meal record for the given date."""
    store = _read_store(user)

    meal_id = str(_uuid_mod.uuid4())
    now = _utcnow_iso()

    meal_record = {
        "meal_id": meal_id,
        "meal_type": body.meal_type,
        "items": [item.model_dump() for item in body.items],
        "notes": body.notes,
        "created_at": now,
    }

    by_date: dict = store.setdefault("by_date", {})
    by_date.setdefault(body.date, []).append(meal_record)

    _write_store(user, store)

    return {
        "meal_id": meal_id,
        "date": body.date,
        "meal_type": body.meal_type,
        "created_at": now,
    }


@router.get("/api/{user}/nutrition/meals")
def list_meals(
    user: str,
    date: Annotated[str, Query(description="YYYY-MM-DD")] = "",
):
    """Return all meals for a given date and daily totals."""
    # Validate date query param
    if not date:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="date query parameter is required",
        )
    import re
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="date must be YYYY-MM-DD",
        )

    store = _read_store(user)
    raw_meals: list[dict] = store.get("by_date", {}).get(date, [])

    meals = [_meal_response(m) for m in raw_meals]
    daily = _daily_totals(raw_meals)

    return {
        "date": date,
        "meals": meals,
        "daily_totals": daily,
    }
