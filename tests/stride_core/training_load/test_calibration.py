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
