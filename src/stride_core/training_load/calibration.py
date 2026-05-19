"""Automatic calibration for objective training-load normalization."""

from __future__ import annotations

from datetime import date, timedelta
from statistics import median
from typing import Sequence

from .types import CalibrationActivity, CalibrationHealthRow, CalibrationSnapshot


def _percentile(values: Sequence[float], pct: float) -> float | None:
    clean = sorted(float(v) for v in values if v is not None)
    if not clean:
        return None
    index = int(round((len(clean) - 1) * pct))
    index = max(0, min(len(clean) - 1, index))
    return clean[index]


def _activity_speed_mps(activity: CalibrationActivity) -> float | None:
    distance_m = activity.distance_m
    if not distance_m or not activity.duration_s or activity.duration_s <= 0:
        return None
    if distance_m < 500:
        return None
    return float(distance_m) / float(activity.duration_s)


def _running(activity: CalibrationActivity) -> bool:
    sport = (activity.sport or "").lower()
    return sport.startswith("run") or sport.startswith("run_")


def estimate_calibration(
    history: Sequence[CalibrationActivity],
    *,
    as_of_date: date,
    health_rows: Sequence[CalibrationHealthRow] = (),
) -> CalibrationSnapshot:
    """Estimate RHR, HRmax, threshold HR/speed, and critical power.

    v1 is deliberately conservative: when evidence is missing it leaves fields
    as ``None`` so raw, non-normalized values stay out of PMC.
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

    recent_history = [
        a for a in history if as_of_date - timedelta(days=180) <= a.activity_date <= as_of_date
    ]

    hr_candidates: list[float] = []
    for activity in recent_history:
        if activity.max_hr is not None and 80 <= float(activity.max_hr) <= 230:
            hr_candidates.append(float(activity.max_hr))
        for sample in activity.samples:
            hr = sample.heart_rate_bpm
            if hr is not None and 80 <= float(hr) <= 230:
                hr_candidates.append(float(hr))
    explicit_max_hr = max(hr_candidates) if hr_candidates else None
    hrmax = explicit_max_hr
    if hrmax is not None:
        source["hrmax_estimate"] = {"method": "p98_180d", "sample_count": len(hr_candidates)}

    run_candidates: list[tuple[float, CalibrationActivity]] = []
    for activity in recent_history:
        if not _running(activity):
            continue
        speed = _activity_speed_mps(activity)
        duration = activity.duration_s or 0
        if speed is None or not (1200 <= duration <= 4500):
            continue
        run_candidates.append((speed, activity))

    threshold_speed = None
    threshold_activity: CalibrationActivity | None = None
    if run_candidates:
        threshold_speed, threshold_activity = max(run_candidates, key=lambda item: item[0])
        source["threshold_speed_mps"] = {
            "method": "best_20_75_min_speed",
            "label_id": threshold_activity.label_id,
        }

    threshold_hr = None
    if threshold_speed is not None and threshold_activity is not None:
        hr_near_threshold = [
            float(sample.heart_rate_bpm)
            for sample in threshold_activity.samples
            if sample.heart_rate_bpm is not None
            and sample.speed_mps is not None
            and abs(float(sample.speed_mps) - threshold_speed) <= max(0.08 * threshold_speed, 0.1)
        ]
        if hr_near_threshold:
            threshold_hr = median(hr_near_threshold)
            source["threshold_hr"] = {
                "method": "median_hr_near_threshold_speed",
                "sample_count": len(hr_near_threshold),
            }

    power_candidates: list[float] = []
    for activity in run_candidates:
        candidate = activity[1]
        if candidate.avg_power is not None and float(candidate.avg_power) > 0:
            power_candidates.append(float(candidate.avg_power))
        power_candidates.extend(
            float(sample.power_w)
            for sample in candidate.samples
            if sample.power_w is not None and float(sample.power_w) > 0
        )
    critical_power = median(power_candidates) if power_candidates else None
    if critical_power is not None:
        source["critical_power_w"] = {"method": "median_180d", "sample_count": len(power_candidates)}

    return CalibrationSnapshot(
        as_of_date=as_of_date,
        rhr_baseline=rhr_baseline,
        hrmax_estimate=hrmax,
        threshold_hr=threshold_hr,
        threshold_speed_mps=threshold_speed,
        critical_power_w=critical_power,
        source=source,
    )
