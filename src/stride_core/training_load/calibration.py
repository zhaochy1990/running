"""Compatibility calibration wrapper for objective training-load normalization."""

from __future__ import annotations

from datetime import date, timedelta
from statistics import median
from typing import Sequence

from stride_core.running_calibration import estimate_running_calibration
from stride_core.running_calibration.types import RunningActivity, RunningSample

from .types import CalibrationActivity, CalibrationHealthRow, CalibrationSnapshot


def _percentile(values: Sequence[float], pct: float) -> float | None:
    clean = sorted(float(v) for v in values if v is not None)
    if not clean:
        return None
    index = int(round((len(clean) - 1) * pct))
    index = max(0, min(len(clean) - 1, index))
    return clean[index]


def _running(activity: CalibrationActivity) -> bool:
    sport = (activity.sport or "").lower()
    return sport == "run" or sport.startswith("run_") or sport.startswith("running")


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


def _estimate_hrmax(history: Sequence[CalibrationActivity], as_of_date: date) -> tuple[float | None, int]:
    recent_history = [
        a for a in history if as_of_date - timedelta(days=180) <= a.activity_date <= as_of_date
    ]
    values: list[float] = []
    for activity in recent_history:
        if activity.max_hr is not None and 80 <= float(activity.max_hr) <= 230:
            values.append(float(activity.max_hr))
        for sample in activity.samples:
            hr = sample.heart_rate_bpm
            if hr is not None and 80 <= float(hr) <= 230:
                values.append(float(hr))
    return (max(values) if values else None, len(values))


def _estimate_critical_power(history: Sequence[CalibrationActivity], as_of_date: date) -> tuple[float | None, int]:
    power_values: list[float] = []
    for activity in history:
        if not (as_of_date - timedelta(days=180) <= activity.activity_date <= as_of_date):
            continue
        if not _running(activity):
            continue
        if activity.avg_power is not None and float(activity.avg_power) > 0:
            power_values.append(float(activity.avg_power))
        power_values.extend(
            float(sample.power_w)
            for sample in activity.samples
            if sample.power_w is not None and float(sample.power_w) > 0
        )
    return (median(power_values) if power_values else None, len(power_values))


def estimate_calibration(
    history: Sequence[CalibrationActivity],
    *,
    as_of_date: date,
    health_rows: Sequence[CalibrationHealthRow] = (),
) -> CalibrationSnapshot:
    """Estimate training-load calibration values.

    Threshold speed and threshold HR now come from
    ``stride_core.running_calibration``. This wrapper keeps the legacy
    ``CalibrationSnapshot`` shape used by training-load computations.
    """
    source: dict[str, dict] = {}

    recent_rhr = [
        float(row.rhr)
        for row in health_rows
        if row.rhr is not None and as_of_date - timedelta(days=90) <= row.date <= as_of_date
    ]
    rhr_baseline = _percentile(recent_rhr, 0.1)
    if rhr_baseline is not None:
        source["rhr_baseline"] = {"method": "p10_90d", "sample_count": len(recent_rhr)}

    hrmax, hrmax_count = _estimate_hrmax(history, as_of_date)
    if hrmax is not None:
        source["hrmax_estimate"] = {"method": "max_valid_180d", "sample_count": hrmax_count}

    running_snapshot = estimate_running_calibration(
        tuple(_to_running_activity(activity) for activity in history),
        as_of_date,
    )
    source["running_calibration"] = running_snapshot.source

    critical_power, power_count = _estimate_critical_power(history, as_of_date)
    if critical_power is not None:
        source["critical_power_w"] = {"method": "median_180d", "sample_count": power_count}

    return CalibrationSnapshot(
        as_of_date=as_of_date,
        rhr_baseline=rhr_baseline,
        hrmax_estimate=hrmax,
        threshold_hr=running_snapshot.threshold_hr,
        threshold_speed_mps=running_snapshot.threshold_speed_mps,
        critical_power_w=critical_power,
        source=source,
    )
