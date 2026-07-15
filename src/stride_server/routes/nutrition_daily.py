"""Nutrition daily target endpoint — GET /api/{user}/nutrition/daily.

Rules-based engine (no LLM). Derives daily calorie + macro targets from
nutrition_prefs.json and the planned_session table.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from ..content_store import read_json
from ..deps import _validate_uuid, get_plan_state_store
from ..weekly_plan_store import get_weekly_plan_store

logger = logging.getLogger(__name__)

router = APIRouter()

# ── Advice templates ──────────────────────────────────────────────────────────
# Keyed by session kind bucket. "rest" is also used when there is no session.

_ADVICE: dict[str, dict[str, str]] = {
    "rest": {
        "pre": "—",
        "intra": "—",
        "post": "—",
    },
    # Easy / Marathon-pace runs (E, M)
    "easy": {
        "pre": "训前 1 小时补充碳水 40–60g（燕麦、香蕉）+ 300ml 水",
        "intra": "30 分钟以内无需补充；超过 45 分钟每 20 分钟补水 150ml",
        "post": "训后 30 分钟内补充蛋白 20–25g + 碳水 40–50g（米饭、面食）",
    },
    # Tempo / Intervals (T, I)
    "hard": {
        "pre": "训前 1–1.5 小时补充碳水 60–80g（米饭、面食）+ 黑咖啡（可选）",
        "intra": "间歇间隙补水 100–150ml；课程超 60 分钟每 30 分钟补充凝胶或糖块",
        "post": "训后 30 分钟内补充蛋白 25–30g + 碳水 60–80g，优先液体（蛋白奶昔 + 果汁）",
    },
    # Race pace / Long run (R, long)
    "race": {
        "pre": "赛前 2–3 小时正餐碳水 80–100g；赛前 30 分钟补充 30g 快碳 + 咖啡因（可选）",
        "intra": "每 45 分钟补充能量胶 1 包（25g 碳水）+ 每站补水",
        "post": "赛后 30 分钟内补充蛋白 30g + 碳水 80–100g；4 小时内完成正餐",
    },
    # Strength / S&C
    "strength": {
        "pre": "训前 1 小时补充蛋白 20g + 碳水 30–40g（鸡蛋 + 燕麦）",
        "intra": "组间补水；超过 60 分钟可补充 BCAA 或碳水饮料",
        "post": "训后 30 分钟内补充蛋白 25–30g + 碳水 40–50g（优先完整餐食）",
    },
}


def _kind_to_bucket(kind: str) -> str:
    """Map planned_session.kind to an advice bucket."""
    kind = (kind or "").lower()
    if kind in ("rest", "note"):
        return "rest"
    if kind == "strength":
        return "strength"
    # For 'run' sessions, the spec_json carries the workout type.
    # Without drilling into spec_json we default to 'easy'; callers that have
    # the full session row pass the run_type hint via _kind_hint.
    return "easy"


def _run_type_to_bucket(run_type: str | None) -> str:
    """Map run workout type (E/M/T/I/R) to advice bucket."""
    if not run_type:
        return "easy"
    t = run_type.upper()
    if t in ("T", "I"):
        return "hard"
    if t in ("R",):
        return "race"
    # E, M, and anything else → easy
    return "easy"


def _load_prefs(user_id: str) -> dict[str, Any] | None:
    """Read nutrition_prefs.json and return the 'current' dict, or None."""
    path = f"{user_id}/nutrition_prefs.json"
    item = read_json(path)
    if item is None:
        return None
    data, _ = item
    if not isinstance(data, dict):
        return None
    current = data.get("current")
    if not isinstance(current, dict):
        return None
    return current


def _get_session_for_date(user_id: str, date_str: str) -> dict[str, Any] | None:
    """Return the first non-rest canonical planned session for a date."""
    plan = get_weekly_plan_store().get_current_plan(user_id, date_str)
    if plan is None:
        legacy = get_plan_state_store(user_id)
        try:
            for row in legacy.get_planned_sessions(
                date_from=date_str, date_to=date_str
            ):
                if row["kind"] not in ("rest", "note"):
                    raw = row["spec_json"]
                    return {
                        "kind": row["kind"],
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
    """Return rules-based daily nutrition targets for a user.

    - Reads nutrition preferences from content_store ({user}/nutrition_prefs.json).
    - Checks planned_session table for a non-rest session on the given date.
    - Applies a +200 kcal training-day bonus on top of TDEE.
    - Derives macro gram targets from percentage splits.
    - Selects static advice text based on session kind.
    """
    _validate_uuid(user)

    # Validate date format early to give a clear 422
    import re
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="date must be in YYYY-MM-DD format",
        )

    # 1. Load prefs
    prefs = _load_prefs(user)
    if prefs is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="请先设置营养偏好",
        )

    # 2. Base kcal: prefer tdee_kcal, fall back to bmr_kcal * 1.5
    tdee = prefs.get("tdee_kcal")
    bmr = prefs.get("bmr_kcal")
    if tdee:
        base_kcal = float(tdee)
    elif bmr:
        base_kcal = float(bmr) * 1.5
    else:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="nutrition_prefs 缺少 tdee_kcal 和 bmr_kcal，无法计算目标热量",
        )

    # 3. Check training day
    session = _get_session_for_date(user, date)
    is_training_day = session is not None

    # 4. Target kcal
    target_kcal = int(round(base_kcal + (200 if is_training_day else 0)))

    # 5. Macros
    protein_pct = float(prefs.get("macro_protein_pct", 0))
    carb_pct = float(prefs.get("macro_carb_pct", 0))
    fat_pct = float(prefs.get("macro_fat_pct", 0))

    protein_g = int(round((target_kcal * protein_pct / 100) / 4))
    carb_g = int(round((target_kcal * carb_pct / 100) / 4))
    fat_g = int(round((target_kcal * fat_pct / 100) / 9))

    # 6. Advice
    if not is_training_day:
        bucket = "rest"
    else:
        kind = (session.get("kind") or "").lower()
        if kind == "strength":
            bucket = "strength"
        elif kind == "run":
            # Try to read the run type from spec_json
            import json as _json
            spec = session.get("spec")
            run_type: str | None = None
            if spec:
                try:
                    run_type = spec.get("run_type") or spec.get("type")
                except Exception:
                    pass
            bucket = _run_type_to_bucket(run_type)
        else:
            # cross, or any other non-rest kind
            bucket = "easy"

    advice_tmpl = _ADVICE[bucket]

    return NutritionDailyOut(
        user_id=user,
        date=date,
        is_training_day=is_training_day,
        target_kcal=target_kcal,
        macros=MacroOut(
            protein_g=protein_g,
            carb_g=carb_g,
            fat_g=fat_g,
        ),
        advice=AdviceOut(
            pre=advice_tmpl["pre"],
            intra=advice_tmpl["intra"],
            post=advice_tmpl["post"],
        ),
    )
