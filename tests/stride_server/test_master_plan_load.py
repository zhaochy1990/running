from __future__ import annotations

from stride_server.coach_adapters.master_plan_load import (
    build_training_history_load_anchor,
    estimate_master_plan_training_load,
)


def _history(kms: list[float]) -> dict:
    return {
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

