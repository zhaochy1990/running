"""Nutrition daily target endpoint — GET /api/{user}/nutrition/daily.

Rules-based engine (no LLM). Derives daily calorie + macro targets from
nutrition_prefs.json and the canonical weekly plan.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from ..content_store import read_json
from ..deps import _validate_uuid, get_plan_state_store
from ..nutrition_rules import build_preferences_baseline, calculate_daily_nutrition
from ..weekly_plan_store import get_weekly_plan_store

logger = logging.getLogger(__name__)
router = APIRouter()


def _load_prefs(user_id: str) -> dict[str, Any] | None:
    """Read nutrition_prefs.json and return its current preference object."""
    item = read_json(f"{user_id}/nutrition_prefs.json")
    if item is None:
        return None
    data, _ = item
    if not isinstance(data, dict):
        return None
    current = data.get("current")
    return current if isinstance(current, dict) else None


def _get_session_for_date(user_id: str, date_str: str) -> dict[str, Any] | None:
    """Return the first non-rest canonical planned session for a date."""
    plan = get_weekly_plan_store().get_current_plan(user_id, date_str)
    if plan is None:
        legacy = get_plan_state_store(user_id)
        try:
            for row in legacy.get_planned_sessions(
                date_from=date_str,
                date_to=date_str,
            ):
                if row["kind"] not in ("rest", "note"):
                    raw = row["spec_json"]
                    return {
                        "kind": row["kind"],
                        "summary": row["summary"] or "",
                        "spec": json.loads(raw) if raw else None,
                    }
        finally:
            legacy.close()
        return None
    for session in sorted(plan.sessions, key=lambda item: item.session_index):
        if session.date != date_str or session.kind.value in ("rest", "note"):
            continue
        return {
            "kind": session.kind.value,
            "summary": session.summary,
            "spec": session.spec.to_dict() if session.spec else None,
        }
    return None


class MacroOut(BaseModel):
    protein_g: int
    carb_g: int
    fat_g: int


class AdviceOut(BaseModel):
    pre: str
    intra: str
    post: str


class NutritionDailyOut(BaseModel):
    user_id: str
    date: str
    is_training_day: bool
    target_kcal: int
    macros: MacroOut
    advice: AdviceOut


@router.get(
    "/api/{user}/nutrition/daily",
    response_model=NutritionDailyOut,
)
def nutrition_daily(
    user: str,
    date: str = Query(..., description="ISO date YYYY-MM-DD"),
) -> NutritionDailyOut:
    """Return rules-based daily nutrition targets for one athlete."""
    _validate_uuid(user)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="date must be in YYYY-MM-DD format",
        )

    prefs = _load_prefs(user)
    if prefs is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="请先设置营养偏好",
        )
    try:
        baseline = build_preferences_baseline(prefs)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    session = _get_session_for_date(user, date)
    kind = str((session or {}).get("kind") or "rest")
    summary = str((session or {}).get("summary") or "")
    spec = (session or {}).get("spec")
    run_type = None
    if isinstance(spec, dict):
        candidate = spec.get("run_type") or spec.get("type")
        run_type = str(candidate) if candidate else None
    target = calculate_daily_nutrition(
        baseline,
        kind=kind,
        summary=summary,
        run_type=run_type,
    )

    return NutritionDailyOut(
        user_id=user,
        date=date,
        is_training_day=target.bucket != "rest",
        target_kcal=target.target_kcal,
        macros=MacroOut(
            protein_g=target.protein_g,
            carb_g=target.carb_g,
            fat_g=target.fat_g,
        ),
        advice=AdviceOut(
            pre=target.pre,
            intra=target.intra,
            post=target.post,
        ),
    )
