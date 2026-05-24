"""Compatibility calibration wrapper for objective training-load normalization."""

from __future__ import annotations

from datetime import date
from typing import Sequence

from stride_core.running_calibration import estimate_running_calibration
from stride_core.running_calibration.types import (
    RunningActivity,
    RunningHealthRow,
    RunningSample,
)

from .types import CalibrationActivity, CalibrationHealthRow, CalibrationSnapshot


def _to_running_activity(activity: CalibrationActivity) -> RunningActivity:
    return RunningActivity(
        label_id=activity.label_id,
        activity_date=activity.activity_date,
        sport=activity.sport,
        duration_s=activity.duration_s,
        distance_m=activity.distance_m,
        avg_hr=activity.avg_hr,
        max_hr=activity.max_hr,
        avg_power_w=activity.avg_power,
        samples=tuple(
            RunningSample(
                timestamp_s=sample.timestamp_s,
                elapsed_s=sample.elapsed_s,
                distance_m=sample.distance_m,
                heart_rate_bpm=sample.heart_rate_bpm,
                speed_mps=sample.speed_mps,
                power_w=sample.power_w,
                altitude_m=sample.altitude_m,
            )
            for sample in activity.samples
        ),
    )


def _to_running_health_row(row: CalibrationHealthRow) -> RunningHealthRow:
    return RunningHealthRow(date=row.date, rhr=row.rhr)


def estimate_calibration(
    history: Sequence[CalibrationActivity],
    *,
    as_of_date: date,
    health_rows: Sequence[CalibrationHealthRow] = (),
) -> CalibrationSnapshot:
    """Estimate training-load calibration values.

    All three baseline metrics (hrmax_estimate, rhr_baseline, critical_power_w)
    are sourced from `stride_core.running_calibration.estimate_running_calibration`
    — this wrapper exists solely to preserve the legacy `CalibrationSnapshot`
    shape consumed by `training_load.adapter`. See CLAUDE.md HARD rule
    "Athlete baseline metrics — single source".
    """
    running_snapshot = estimate_running_calibration(
        tuple(_to_running_activity(activity) for activity in history),
        as_of_date,
        health_rows=tuple(_to_running_health_row(r) for r in health_rows),
    )
    source: dict[str, dict] = {"running_calibration": running_snapshot.source}
    if running_snapshot.hrmax_estimate is not None:
        source["hrmax_estimate"] = {"source": "running_calibration"}
    if running_snapshot.rhr_baseline is not None:
        source["rhr_baseline"] = {"source": "running_calibration", "method": "p10_90d"}
    if running_snapshot.critical_power_w is not None:
        source["critical_power_w"] = {"source": "running_calibration", "method": "median_180d"}
    return CalibrationSnapshot(
        as_of_date=as_of_date,
        rhr_baseline=running_snapshot.rhr_baseline,
        hrmax_estimate=running_snapshot.hrmax_estimate,
        threshold_hr=running_snapshot.threshold_hr,
        threshold_speed_mps=running_snapshot.threshold_speed_mps,
        critical_power_w=running_snapshot.critical_power_w,
        source=source,
    )
