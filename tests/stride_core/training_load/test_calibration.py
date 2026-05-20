from __future__ import annotations

from datetime import date, timedelta

import pytest

from stride_core.training_load.calibration import estimate_calibration
from stride_core.training_load.types import (
    CalibrationActivity,
    CalibrationHealthRow,
    CalibrationSample,
)


def test_estimates_resting_hr_from_low_percentile_health_history():
    as_of = date(2026, 5, 1)
    health = [
        CalibrationHealthRow(date=as_of - timedelta(days=i), rhr=value)
        for i, value in enumerate((51, 49, 50, 48, 52, 47, 53, 46, 54, 55, 56, 57, 58, 59))
    ]

    calibration = estimate_calibration([], as_of_date=as_of, health_rows=health)

    assert calibration.rhr_baseline == pytest.approx(47.0, abs=1.0)
    assert calibration.source["rhr_baseline"]["sample_count"] == 14


def test_estimates_hrmax_threshold_speed_and_power_from_history():
    as_of = date(2026, 5, 1)
    activity = CalibrationActivity(
        label_id="tempo1",
        activity_date=as_of - timedelta(days=2),
        sport="run_outdoor",
        duration_s=3600,
        distance_m=14400,
        avg_hr=168,
        max_hr=186,
        avg_power=302,
        samples=tuple(
            CalibrationSample(
                elapsed_s=float(i),
                distance_m=4.0 * i,
                heart_rate_bpm=170,
                speed_mps=4.0,
                power_w=300,
            )
            for i in range(0, 3601, 30)
        ),
    )

    calibration = estimate_calibration([activity], as_of_date=as_of)

    assert calibration.hrmax_estimate == pytest.approx(186.0)
    assert calibration.threshold_speed_mps == pytest.approx(4.0, rel=0.02)
    assert calibration.threshold_hr == pytest.approx(170.0, abs=2.0)
    assert calibration.critical_power_w == pytest.approx(300.0, rel=0.03)


def _steady_activity(
    label_id: str,
    as_of: date,
    *,
    days_ago: int,
    duration_s: int,
    speed_mps: float,
    avg_hr: int,
    max_hr: int,
) -> CalibrationActivity:
    return CalibrationActivity(
        label_id=label_id,
        activity_date=as_of - timedelta(days=days_ago),
        sport="run_outdoor",
        duration_s=duration_s,
        distance_m=speed_mps * duration_s,
        avg_hr=avg_hr,
        max_hr=max_hr,
        samples=tuple(
            CalibrationSample(
                elapsed_s=float(i),
                distance_m=speed_mps * i,
                heart_rate_bpm=avg_hr,
                speed_mps=speed_mps,
            )
            for i in range(0, duration_s + 1, 30)
        ),
    )


def test_threshold_hr_uses_plausible_sustained_efforts_not_fastest_race_hr():
    as_of = date(2026, 5, 1)
    health = [CalibrationHealthRow(date=as_of - timedelta(days=i), rhr=47) for i in range(30)]
    history = [
        _steady_activity("10k_race", as_of, days_ago=2, duration_s=2450, speed_mps=4.1, avg_hr=176, max_hr=184),
        _steady_activity("tempo_1", as_of, days_ago=7, duration_s=3600, speed_mps=4.0, avg_hr=166, max_hr=178),
        _steady_activity("tempo_2", as_of, days_ago=14, duration_s=4200, speed_mps=3.9, avg_hr=164, max_hr=176),
    ]

    calibration = estimate_calibration(history, as_of_date=as_of, health_rows=health)

    assert calibration.threshold_speed_mps == pytest.approx(4.0, rel=0.01)
    assert calibration.threshold_hr == pytest.approx(165.0, abs=2.0)


def test_threshold_hr_rejects_low_hr_outlier_at_fast_threshold_speed():
    as_of = date(2026, 5, 1)
    health = [CalibrationHealthRow(date=as_of - timedelta(days=i), rhr=42) for i in range(30)]
    history = [
        _steady_activity("low_hr_fast", as_of, days_ago=2, duration_s=1800, speed_mps=4.5, avg_hr=140, max_hr=200),
        _steady_activity("hard_10k", as_of, days_ago=7, duration_s=2280, speed_mps=4.4, avg_hr=168, max_hr=181),
        _steady_activity("hard_tempo", as_of, days_ago=14, duration_s=2400, speed_mps=4.25, avg_hr=169, max_hr=180),
    ]

    calibration = estimate_calibration(history, as_of_date=as_of, health_rows=health)

    assert calibration.threshold_speed_mps == pytest.approx(4.32, rel=0.01)
    assert calibration.threshold_hr == pytest.approx(168.5, abs=2.0)
