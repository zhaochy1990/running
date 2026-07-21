"""Shared rules for daily and weekly nutrition targets.

The HTTP daily-nutrition endpoint and deterministic weekly-plan generator use
this module as the single calculation source. Storage and request validation
stay in their adapter layers; all functions here are pure.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date as date_cls, timedelta
import math
from typing import Any, Literal

from stride_core.plan_spec import Meal, PlannedNutrition, PlannedSession

NutritionBucket = Literal["rest", "easy", "hard", "race", "strength"]

_DEFAULT_BASE_KCAL = 2_200.0
_DEFAULT_KCAL_PER_KG = 40.0
_DEFAULT_PROTEIN_PCT = 18.0
_DEFAULT_CARB_PCT = 57.0
_DEFAULT_FAT_PCT = 25.0
_TRAINING_DAY_BONUS_KCAL = 200.0
_REST_WATER_ML = 2_500.0
_TRAINING_WATER_ML = 3_000.0

_ADVICE: dict[NutritionBucket, dict[str, str]] = {
    "rest": {
        "pre": "—",
        "intra": "—",
        "post": "—",
    },
    "easy": {
        "pre": "训前 1 小时补充碳水 40–60g（燕麦、香蕉）+ 300ml 水",
        "intra": "30 分钟以内无需补充；超过 45 分钟每 20 分钟补水 150ml",
        "post": "训后 30 分钟内补充蛋白 20–25g + 碳水 40–50g（米饭、面食）",
    },
    "hard": {
        "pre": "训前 1–1.5 小时补充碳水 60–80g（米饭、面食）+ 黑咖啡（可选）",
        "intra": "间歇间隙补水 100–150ml；课程超 60 分钟每 30 分钟补充凝胶或糖块",
        "post": "训后 30 分钟内补充蛋白 25–30g + 碳水 60–80g，优先液体（蛋白奶昔 + 果汁）",
    },
    "race": {
        "pre": "训练前 2–3 小时正餐碳水 80–100g；开始前 30 分钟补充 30g 快碳",
        "intra": "每 45 分钟补充能量胶 1 包（约 25g 碳水）并规律补水",
        "post": "训练后 30 分钟内补充蛋白 30g + 碳水 80–100g；4 小时内完成正餐",
    },
    "strength": {
        "pre": "训前 1 小时补充蛋白 20g + 碳水 30–40g（鸡蛋 + 燕麦）",
        "intra": "组间补水；超过 60 分钟可补充碳水饮料",
        "post": "训后 30 分钟内补充蛋白 25–30g + 碳水 40–50g（优先完整餐食）",
    },
}


@dataclass(frozen=True)
class NutritionBaseline:
    base_kcal: float
    protein_pct: float
    carb_pct: float
    fat_pct: float
    source: str
    source_note: str


@dataclass(frozen=True)
class DailyNutritionTarget:
    bucket: NutritionBucket
    target_kcal: int
    protein_g: int
    carb_g: int
    fat_g: int
    water_ml: int
    pre: str
    intra: str
    post: str


def _positive_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def build_preferences_baseline(prefs: dict[str, Any]) -> NutritionBaseline:
    """Build the established daily-API baseline from saved preferences."""
    tdee = _positive_number(prefs.get("tdee_kcal"))
    bmr = _positive_number(prefs.get("bmr_kcal"))
    if tdee is not None:
        base_kcal = tdee
        source = "nutrition_preferences_tdee"
        source_note = "热量与宏量营养来自已保存的营养偏好（TDEE）"
    elif bmr is not None:
        base_kcal = bmr * 1.5
        source = "nutrition_preferences_bmr"
        source_note = "热量来自已保存的 BMR × 1.5 估算，宏量营养来自营养偏好"
    else:
        raise ValueError("nutrition_prefs 缺少 tdee_kcal 和 bmr_kcal，无法计算目标热量")

    try:
        protein_pct = float(prefs["macro_protein_pct"])
        carb_pct = float(prefs["macro_carb_pct"])
        fat_pct = float(prefs["macro_fat_pct"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("macro percentages must be finite values in [0, 100]") from exc
    macro_percentages = (protein_pct, carb_pct, fat_pct)
    if (
        any(not math.isfinite(value) or not 0 <= value <= 100 for value in macro_percentages)
        or abs(sum(macro_percentages) - 100) > 1
    ):
        raise ValueError("macro percentages must be in [0, 100] and sum to 100 ±1")

    return NutritionBaseline(
        base_kcal=base_kcal,
        protein_pct=protein_pct,
        carb_pct=carb_pct,
        fat_pct=fat_pct,
        source=source,
        source_note=source_note,
    )


def build_fallback_baseline(
    *,
    weight_kg: float | None,
    bmr_kcal: float | None,
) -> NutritionBaseline:
    """Build an explicitly labelled fallback when preferences are absent."""
    bmr = _positive_number(bmr_kcal)
    weight = _positive_number(weight_kg)
    if bmr is not None:
        base_kcal = bmr * 1.5
        source = "body_composition_bmr_estimate"
        source_note = "未设置营养偏好；按最新体测 BMR × 1.5 估算，请在营养设置中校准"
    elif weight is not None:
        base_kcal = weight * _DEFAULT_KCAL_PER_KG
        source = "profile_weight_estimate"
        source_note = (
            f"未设置营养偏好；按档案体重 {weight:.1f} kg × "
            f"{_DEFAULT_KCAL_PER_KG:.0f} kcal/kg 估算，请在营养设置中校准"
        )
    else:
        base_kcal = _DEFAULT_BASE_KCAL
        source = "generic_estimate"
        source_note = "缺少营养偏好、体重和 BMR；当前为通用估算，请先完善档案并校准"

    return NutritionBaseline(
        base_kcal=base_kcal,
        protein_pct=_DEFAULT_PROTEIN_PCT,
        carb_pct=_DEFAULT_CARB_PCT,
        fat_pct=_DEFAULT_FAT_PCT,
        source=source,
        source_note=source_note,
    )


def classify_nutrition_bucket(
    *,
    kind: str,
    summary: str = "",
    run_type: str | None = None,
) -> NutritionBucket:
    normalized_kind = (kind or "").lower()
    normalized_summary = (summary or "").lower()
    if normalized_kind in {"rest", "note", ""}:
        return "rest"
    if normalized_kind == "strength":
        return "strength"
    if normalized_kind != "run":
        return "easy"

    type_hint = (run_type or "").upper()
    if type_hint == "R" or any(
        marker in normalized_summary
        for marker in ("长距离", "比赛", "race", "long run")
    ):
        return "race"
    if type_hint in {"T", "I"} or any(
        marker in normalized_summary
        for marker in ("节奏", "间歇", "阈值", "tempo", "interval")
    ):
        return "hard"
    return "easy"


def calculate_daily_nutrition(
    baseline: NutritionBaseline,
    *,
    kind: str,
    summary: str = "",
    run_type: str | None = None,
) -> DailyNutritionTarget:
    bucket = classify_nutrition_bucket(
        kind=kind,
        summary=summary,
        run_type=run_type,
    )
    is_training_day = bucket != "rest"
    target_kcal = int(
        round(
            baseline.base_kcal
            + (_TRAINING_DAY_BONUS_KCAL if is_training_day else 0)
        )
    )
    advice = _ADVICE[bucket]
    return DailyNutritionTarget(
        bucket=bucket,
        target_kcal=target_kcal,
        protein_g=int(round((target_kcal * baseline.protein_pct / 100) / 4)),
        carb_g=int(round((target_kcal * baseline.carb_pct / 100) / 4)),
        fat_g=int(round((target_kcal * baseline.fat_pct / 100) / 9)),
        water_ml=int(_TRAINING_WATER_ML if is_training_day else _REST_WATER_ML),
        pre=advice["pre"],
        intra=advice["intra"],
        post=advice["post"],
    )


def _timing_meals(target: DailyNutritionTarget) -> tuple[Meal, ...]:
    if target.bucket == "rest":
        return (
            Meal(
                name="日常餐食",
                time_hint="三餐均匀分配",
                items_md="每餐包含优质蛋白、全谷物和蔬菜；休息日不额外增加训练碳水。",
            ),
        )
    return (
        Meal(name="训练前补给", time_hint="训练前 60–90 分钟", items_md=target.pre),
        Meal(name="训练中补给", time_hint="训练中", items_md=target.intra),
        Meal(name="训练后恢复", time_hint="训练后 30 分钟内", items_md=target.post),
    )


def build_weekly_nutrition(
    *,
    week_start: date_cls,
    sessions: Sequence[PlannedSession],
    baseline: NutritionBaseline,
) -> tuple[PlannedNutrition, ...]:
    """Project seven daily targets from the final weekly session layout."""
    sessions_by_date: dict[str, list[PlannedSession]] = {}
    for session in sessions:
        sessions_by_date.setdefault(session.date, []).append(session)

    bucket_priority = {"rest": 0, "easy": 1, "strength": 2, "hard": 3, "race": 4}
    rows: list[PlannedNutrition] = []
    for offset in range(7):
        day = (week_start + timedelta(days=offset)).isoformat()
        day_sessions = sessions_by_date.get(day, [])
        choices = [
            (
                classify_nutrition_bucket(
                    kind=session.kind.value,
                    summary=session.summary,
                ),
                session,
            )
            for session in day_sessions
        ]
        if choices:
            _, primary = max(choices, key=lambda item: bucket_priority[item[0]])
            kind = primary.kind.value
            summary = primary.summary
        else:
            kind = "rest"
            summary = ""
        target = calculate_daily_nutrition(
            baseline,
            kind=kind,
            summary=summary,
        )
        rows.append(
            PlannedNutrition(
                date=day,
                kcal_target=target.target_kcal,
                carbs_g=target.carb_g,
                protein_g=target.protein_g,
                fat_g=target.fat_g,
                water_ml=target.water_ml,
                meals=_timing_meals(target),
                notes_md=(
                    f"{baseline.source_note}；训练日统一增加 "
                    f"{int(_TRAINING_DAY_BONUS_KCAL)} kcal。"
                ),
            )
        )
    return tuple(rows)
