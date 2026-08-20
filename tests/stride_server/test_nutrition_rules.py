from __future__ import annotations

import pytest

from stride_server.nutrition_rules import (
    build_fallback_baseline,
    build_preferences_baseline,
    calculate_daily_nutrition,
)


def test_preferences_baseline_preserves_existing_daily_api_math() -> None:
    baseline = build_preferences_baseline(
        {
            "tdee_kcal": 2200,
            "bmr_kcal": 1550,
            "macro_protein_pct": 30,
            "macro_carb_pct": 45,
            "macro_fat_pct": 25,
        }
    )

    target = calculate_daily_nutrition(baseline, kind="run", summary="E 轻松跑")

    assert target.target_kcal == 2400
    assert target.protein_g == 180
    assert target.carb_g == 270
    assert target.fat_g == 67
    assert target.water_ml == 3000


def test_long_run_uses_race_fueling_guidance() -> None:
    baseline = build_preferences_baseline(
        {
            "tdee_kcal": 2200,
            "macro_protein_pct": 20,
            "macro_carb_pct": 55,
            "macro_fat_pct": 25,
        }
    )

    target = calculate_daily_nutrition(
        baseline,
        kind="run",
        summary="E 长距离跑（24K）",
    )

    assert target.bucket == "race"
    assert "能量胶" in target.intra
    assert "碳水" in target.pre
    assert "蛋白" in target.post


@pytest.mark.parametrize(
    "macros",
    [
        {"macro_protein_pct": 20, "macro_carb_pct": 40, "macro_fat_pct": 20},
        {"macro_protein_pct": -5, "macro_carb_pct": 80, "macro_fat_pct": 25},
        {"macro_protein_pct": "invalid", "macro_carb_pct": 55, "macro_fat_pct": 25},
    ],
)
def test_preferences_baseline_rejects_invalid_macro_percentages(macros: dict) -> None:
    with pytest.raises(ValueError, match="macro percentages"):
        build_preferences_baseline({"tdee_kcal": 2200, **macros})


def test_weight_fallback_is_explicitly_marked_as_estimate() -> None:
    baseline = build_fallback_baseline(weight_kg=72, bmr_kcal=None)

    target = calculate_daily_nutrition(baseline, kind="rest")

    assert baseline.base_kcal == 2880
    assert baseline.source == "profile_weight_estimate"
    assert "估算" in baseline.source_note
    assert target.target_kcal == 2880
    assert target.water_ml == 2500
