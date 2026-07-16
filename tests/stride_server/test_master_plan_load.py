from __future__ import annotations

import pytest

from stride_server.coach_adapters.master_plan_load import (
    build_training_history_load_anchor,
    estimate_master_plan_training_load,
)


def _history(kms: list[float]) -> dict:
    return {
        "threshold_speed_mps": 4.0,
        "max_weekly_km": max(kms),
        "weekly_profile": [
            {
                "week_start": f"2026-01-{idx:02d}",
                "distance_km": km,
                "hours": km * 5 / 60,
                "dose": km * 0.78,
                "n_runs": 6,
            }
            for idx, km in enumerate(kms, start=1)
        ],
    }


def _plan(highs: list[float], *, distance: str = "HM") -> dict:
    return {
        "goal": {"distance": distance},
        "weeks": [
            {
                "week_index": idx,
                "week_start": f"2026-07-{idx:02d}",
                "target_weekly_km_high": km,
                "key_sessions": [{"type": "long_run", "distance_km": min(24, max(10, km * 0.25))}],
            }
            for idx, km in enumerate(highs, start=1)
        ],
    }


def test_high_history_hm_underload_is_flagged() -> None:
    anchor = build_training_history_load_anchor(_history([145, 152, 150, 158, 149, 151, 154, 150]))

    estimate = estimate_master_plan_training_load(
        _plan([60, 65, 70, 44, 70, 75], distance="HM"),
        history_anchor=anchor,
        target_race={"distance": "hm"},
        weekly_run_days_max=6,
    )

    assert estimate["history_anchor"]["advanced_history"] is True
    assert estimate["alignment"]["status"] == "underload"
    assert {i["kind"] for i in estimate["alignment"]["issues"]} >= {
        "underload_start",
        "underload_peak",
    }


def test_high_history_hm_preserved_load_passes() -> None:
    anchor = build_training_history_load_anchor(_history([145, 152, 150, 158, 149, 151, 154, 150]))

    estimate = estimate_master_plan_training_load(
        _plan([118, 126, 135, 100, 142, 150], distance="HM"),
        history_anchor=anchor,
        target_race={"distance": "hm"},
        weekly_run_days_max=6,
    )

    assert estimate["alignment"]["status"] == "ok"


def test_low_history_short_race_not_forced_up() -> None:
    anchor = build_training_history_load_anchor(_history([25, 32, 28, 35]))

    estimate = estimate_master_plan_training_load(
        _plan([32, 35, 38, 28], distance="10K"),
        history_anchor=anchor,
        target_race={"distance": "10k"},
        weekly_run_days_max=5,
    )

    assert estimate["history_anchor"]["advanced_history"] is False
    assert estimate["alignment"]["status"] == "ok"


def test_long_run_ratios_are_estimated_from_weekly_load() -> None:
    anchor = build_training_history_load_anchor(_history([45, 48, 50, 52]))

    estimate = estimate_master_plan_training_load(
        {
            "goal": {"distance": "10K"},
            "weeks": [
                {
                    "week_index": 1,
                    "week_start": "2026-07-01",
                    "target_weekly_km_high": 60,
                    "key_sessions": [
                        {"type": "long_run", "distance_km": 18},
                        {"type": "threshold", "distance_km": 8},
                    ],
                }
            ],
        },
        history_anchor=anchor,
        target_race={"distance": "10k"},
        weekly_run_days_max=5,
    )

    week = estimate["weeks"][0]
    assert week["target_training_dose_low"] <= week["target_training_dose_high"]
    assert week["target_training_dose_high"] >= week["estimated_dose"]
    assert week["long_run_km"] == 18.0
    assert week["long_run_km_ratio"] == 0.3
    assert week["key_session_km_ratio"] == 0.43
    assert estimate["plan_summary"]["max_long_run_km_ratio"] == 0.3


def test_weekly_dose_low_and_high_include_volume_and_intensity_ranges() -> None:
    anchor = build_training_history_load_anchor(_history([45, 48, 50, 52]))
    common = {
        "goal": {"distance": "10K"},
        "weeks": [{
            "week_index": 1,
            "week_start": "2026-07-01",
            "target_weekly_km_low": 50,
            "target_weekly_km_high": 60,
            "key_sessions": [{"type": "threshold", "distance_km": 8}],
        }],
    }
    ranged = estimate_master_plan_training_load(common, history_anchor=anchor)

    low_only = estimate_master_plan_training_load(
        {**common, "weeks": [{**common["weeks"][0], "target_weekly_km_high": 50}]},
        history_anchor=anchor,
    )
    high_only = estimate_master_plan_training_load(
        {**common, "weeks": [{**common["weeks"][0], "target_weekly_km_low": 60}]},
        history_anchor=anchor,
    )

    week = ranged["weeks"][0]
    assert week["target_training_dose_low"] == low_only["weeks"][0]["estimated_dose_low"]
    assert week["target_training_dose_high"] == high_only["weeks"][0]["estimated_dose_high"]
    assert week["target_training_dose_low"] < low_only["weeks"][0]["estimated_dose"]
    assert week["target_training_dose_high"] > week["estimated_dose"]


def test_missing_threshold_does_not_fall_back_to_fixed_pace() -> None:
    estimate = estimate_master_plan_training_load(
        {
            "goal": {"distance": "10K"},
            "weeks": [{
                "week_index": 1,
                "week_start": "2026-07-01",
                "target_weekly_km_low": 50,
                "target_weekly_km_high": 60,
                "key_sessions": [{"type": "threshold", "distance_km": 8}],
            }],
        },
        history_anchor={
            "distance_anchor_km": 49.0,
            "dose_anchor": 38.2,
            "avg_pace_s_km": 300.0,
        },
    )

    week = estimate["weeks"][0]
    assert week["target_training_dose_low"] is None
    assert week["target_training_dose_high"] is None
    assert week["estimated_dose"] is None
    assert week["load_computable"] is False
    assert estimate["unavailable_reason"] == "personal_threshold_unavailable"
    assert "dose_scale" not in estimate["plan_summary"]


def test_vendor_history_dose_does_not_rescale_planned_load() -> None:
    plan = {
        "goal": {"distance": "10K"},
        "weeks": [{
            "week_index": 1,
            "week_start": "2026-07-01",
            "target_weekly_km_low": 50,
            "target_weekly_km_high": 60,
            "key_sessions": [{"type": "threshold", "distance_km": 8}],
        }],
    }
    base_anchor = {"threshold_speed_mps": 4.0, "distance_anchor_km": 49.0}

    low_vendor_dose = estimate_master_plan_training_load(
        plan, history_anchor={**base_anchor, "dose_anchor": 10.0}
    )
    high_vendor_dose = estimate_master_plan_training_load(
        plan, history_anchor={**base_anchor, "dose_anchor": 500.0}
    )

    assert low_vendor_dose["weeks"][0]["estimated_dose"] == (
        high_vendor_dose["weeks"][0]["estimated_dose"]
    )


def test_long_run_load_concentration_is_flagged_without_distance_caps() -> None:
    anchor = build_training_history_load_anchor(_history([45, 48, 50, 52]))

    estimate = estimate_master_plan_training_load(
        {
            "goal": {"distance": "10K"},
            "weeks": [
                {
                    "week_index": 1,
                    "week_start": "2026-07-01",
                    "target_weekly_km_high": 38,
                    "key_sessions": [{"type": "long_run", "distance_km": 22}],
                }
            ],
        },
        history_anchor=anchor,
        target_race={"distance": "10k"},
        weekly_run_days_max=5,
    )

    assert estimate["alignment"]["status"] == "overload"
    issue = estimate["alignment"]["issues"][0]
    assert issue["kind"] == "overload_long_run_load"
    assert issue["details"]["long_run_km_ratio"] == 0.58
    assert "fixed distance template" in issue["message"]


def test_long_run_concentration_still_runs_with_insufficient_history() -> None:
    anchor = build_training_history_load_anchor(_history([32, 35, 30]))

    estimate = estimate_master_plan_training_load(
        {
            "goal": {"distance": "FM"},
            "weeks": [
                {
                    "week_index": 1,
                    "week_start": "2026-07-01",
                    "target_weekly_km_high": 45,
                    "key_sessions": [{"type": "long_run", "distance_km": 28}],
                }
            ],
        },
        history_anchor=anchor,
        target_race={"distance": "fm"},
        weekly_run_days_max=5,
    )

    assert estimate["history_anchor"]["history_active_weeks"] == 3
    assert estimate["alignment"]["status"] == "overload"
    assert estimate["alignment"]["issues"][0]["kind"] == "overload_long_run_load"


def test_three_day_runner_protected_long_run_uses_wider_load_threshold() -> None:
    anchor = build_training_history_load_anchor(_history([38, 40, 42, 39]))

    estimate = estimate_master_plan_training_load(
        {
            "goal": {"distance": "FM"},
            "weeks": [
                {
                    "week_index": 1,
                    "week_start": "2026-07-01",
                    "target_weekly_km_high": 48,
                    "key_sessions": [{"type": "long_run", "distance_km": 28}],
                }
            ],
        },
        history_anchor=anchor,
        target_race={"distance": "fm"},
        weekly_run_days_max=3,
    )

    assert estimate["weeks"][0]["long_run_km_ratio"] == 0.58
    assert estimate["alignment"]["status"] == "ok"


def test_missing_personal_threshold_omits_load_instead_of_using_fixed_pace() -> None:
    anchor = build_training_history_load_anchor(_history([30, 32, 35, 33]))
    anchor["threshold_speed_mps"] = None

    estimate = estimate_master_plan_training_load(
        _plan([40], distance="FM"),
        history_anchor=anchor,
        target_race={"distance": "fm", "target_time": "4:30:00"},
    )

    assert estimate["weeks"][0]["target_weekly_km_high"] == 40.0
    assert estimate["weeks"][0]["estimated_dose"] is None
    assert estimate["weeks"][0]["load_computable"] is False


def test_fm_race_load_uses_goal_pace_not_fixed_if() -> None:
    anchor = build_training_history_load_anchor(_history([55, 58, 60, 62]))
    plan = {
        "goal": {"distance": "FM", "target_time": "4:00:00"},
        "weeks": [{
            "week_index": 1,
            "week_start": "2026-07-01",
            "target_weekly_km_high": 42.195,
            "key_sessions": [{"type": "race", "distance_km": 42.195}],
        }],
    }

    estimate = estimate_master_plan_training_load(
        plan, history_anchor=anchor, target_race={"distance": "fm", "target_time": "4:00:00"}
    )

    expected_if = (42195 / (4 * 3600)) / 4.0
    expected = (4.0 * expected_if**2) * 100.0
    assert estimate["weeks"][0]["estimated_dose"] == pytest.approx(expected, rel=0.01)


def test_distance_only_tune_up_race_keeps_week_load_computable() -> None:
    anchor = build_training_history_load_anchor(_history([55, 58, 60, 62]))
    estimate = estimate_master_plan_training_load(
        {
            "goal": {"distance": "FM", "target_time": "4:00:00"},
            "weeks": [{
                "week_index": 1,
                "week_start": "2026-07-01",
                "target_weekly_km_low": 40,
                "target_weekly_km_high": 50,
                "key_sessions": [{"type": "tune_up_race", "distance_km": 21.0975}],
            }],
        },
        history_anchor=anchor,
    )

    week = estimate["weeks"][0]
    assert week["load_computable"] is True
    assert week["target_training_dose_low"] is not None
    assert week["target_training_dose_high"] is not None
    assert "tune_up_distance_only_hm_marathon_to_threshold_range" in week["load_assumptions"]


def test_distance_only_goal_race_keeps_week_load_computable() -> None:
    anchor = build_training_history_load_anchor(_history([55, 58, 60, 62]))
    estimate = estimate_master_plan_training_load(
        {
            "goal": {"distance": "trail"},
            "weeks": [{
                "week_index": 1,
                "week_start": "2026-07-01",
                "target_weekly_km_low": 42.195,
                "target_weekly_km_high": 42.195,
                "key_sessions": [{"type": "race", "distance_km": 42.195}],
            }],
        },
        history_anchor=anchor,
    )

    week = estimate["weeks"][0]
    assert week["load_computable"] is True
    assert week["target_training_dose_low"] is not None
    assert week["target_training_dose_high"] is not None
    assert "goal_race_distance_only_long_race_marathon_range" in week["load_assumptions"]


def test_distance_only_race_pace_uses_goal_distance_not_segment_distance() -> None:
    anchor = build_training_history_load_anchor(_history([55, 58, 60, 62]))
    estimate = estimate_master_plan_training_load(
        {
            "goal": {"distance": "FM"},
            "weeks": [{
                "week_index": 1, "week_start": "2026-07-01",
                "target_weekly_km_high": 50,
                "key_sessions": [{"type": "race_pace", "distance_km": 10}],
            }],
        },
        history_anchor=anchor,
    )

    assert (
        "goal_race_distance_only_long_race_marathon_range"
        in estimate["weeks"][0]["load_assumptions"]
    )


def test_embedded_race_pace_raises_long_run_load_without_double_counting_km() -> None:
    anchor = build_training_history_load_anchor(_history([55, 58, 60, 62]))
    base_week = {
        "week_index": 1,
        "week_start": "2026-07-01",
        "target_weekly_km_high": 50,
        "key_sessions": [{"type": "long_run", "distance_km": 30}],
    }
    easy = estimate_master_plan_training_load(
        {"goal": {"distance": "FM", "target_time": "3:00:00"},
         "weeks": [base_week]},
        history_anchor=anchor,
    )
    embedded = estimate_master_plan_training_load(
        {"goal": {"distance": "FM", "target_time": "3:00:00"},
         "weeks": [{**base_week, "key_sessions": [
             {"type": "long_run", "distance_km": 30},
             {"type": "race_pace", "distance_km": 12,
              "purpose": "embedded within long run"},
         ]}]},
        history_anchor=anchor,
    )

    assert embedded["weeks"][0]["key_session_km"] == 30.0
    assert embedded["weeks"][0]["estimated_dose"] > easy["weeks"][0]["estimated_dose"]
    assert embedded["weeks"][0]["long_run_dose"] > easy["weeks"][0]["long_run_dose"]


def test_long_run_mp_marker_does_not_match_inside_ordinary_words() -> None:
    anchor = build_training_history_load_anchor(_history([55, 58, 60, 62]))
    common_week = {
        "week_index": 1,
        "week_start": "2026-07-01",
        "target_weekly_km_high": 50,
    }

    ordinary = estimate_master_plan_training_load(
        {
            "goal": {"distance": "FM", "target_time": "4:00:00"},
            "weeks": [{
                **common_week,
                "key_sessions": [{
                    "type": "long_run",
                    "distance_km": 24,
                    "purpose": "improve aerobic endurance",
                }],
            }],
        },
        history_anchor=anchor,
    )
    explicit_mp = estimate_master_plan_training_load(
        {
            "goal": {"distance": "FM", "target_time": "4:00:00"},
            "weeks": [{
                **common_week,
                "key_sessions": [{
                    "type": "long_run",
                    "distance_km": 24,
                    "intensity": "MP",
                }],
            }],
        },
        history_anchor=anchor,
    )

    ordinary_assumptions = ordinary["weeks"][0]["load_assumptions"]
    assert "long_run_easy_zone_range" in ordinary_assumptions
    assert "mp_fraction_unspecified_range_easy_to_goal_pace" not in ordinary_assumptions
    assert (
        "mp_fraction_unspecified_range_easy_to_goal_pace"
        in explicit_mp["weeks"][0]["load_assumptions"]
    )


def test_quality_session_endurance_wording_is_not_treated_as_embedded() -> None:
    anchor = build_training_history_load_anchor(_history([55, 58, 60, 62]))
    estimate = estimate_master_plan_training_load(
        {
            "goal": {"distance": "FM", "target_time": "4:00:00"},
            "weeks": [{
                "week_index": 1,
                "week_start": "2026-07-01",
                "target_weekly_km_high": 50,
                "key_sessions": [{
                    "type": "threshold",
                    "distance_km": 8,
                    "purpose": "提升后段维持能力",
                }],
            }],
        },
        history_anchor=anchor,
    )

    week = estimate["weeks"][0]
    assert week["key_session_km"] == 8.0
    assert "threshold_zone_range" in week["load_assumptions"]
    assert "threshold_embedded_in_parent_not_double_counted" not in week["load_assumptions"]
