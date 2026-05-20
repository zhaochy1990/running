"""Pure running threshold calibration algorithms."""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, timedelta
from statistics import median
from typing import Sequence

from .segments import (
    SpeedCandidate,
    ThresholdHrCandidate,
    best_speed_candidates,
    evidence_from_hr,
    evidence_from_speed,
    stable_threshold_hr_candidates,
    weighted_median,
)
from .types import CalibrationConfidence, CalibrationEvidence, RunningActivity, RunningCalibrationSnapshot

BEST_EFFORT_DURATIONS_S = (3 * 60, 5 * 60, 10 * 60, 20 * 60, 30 * 60, 45 * 60, 60 * 60)


def estimate_running_calibration(
    history: Sequence[RunningActivity], as_of_date: date,
) -> RunningCalibrationSnapshot:
    """Estimate running threshold speed, threshold HR, and supporting evidence.

    The function accepts only in-memory domain objects. Database fields,
    provider-specific units, and persistence are connector responsibilities.
    """
    recent = [a for a in history if as_of_date - timedelta(days=180) <= a.activity_date <= as_of_date]
    source: dict[str, object] = {"algorithm": "running_calibration_v1", "lookback_days": 180}
    evidence: list[CalibrationEvidence] = []

    speed_candidates = best_speed_candidates(recent, BEST_EFFORT_DURATIONS_S)
    threshold_speed, speed_confidence, speed_evidence = _estimate_threshold_speed(speed_candidates)
    if threshold_speed is not None:
        source["threshold_speed"] = {
            "method": "best_efforts_critical_speed_curve",
            "candidate_count": len(speed_candidates),
        }
        evidence.extend(speed_evidence)

    threshold_hr = None
    hr_confidence = CalibrationConfidence.NONE
    if threshold_speed is not None:
        hr_candidates = stable_threshold_hr_candidates(recent, threshold_speed)
        threshold_hr, hr_confidence, hr_evidence = _estimate_threshold_hr(
            hr_candidates,
            hrmax_estimate=_observed_activity_hrmax(recent) or _estimate_hrmax(recent),
        )
        if threshold_hr is not None:
            source["threshold_hr"] = {
                "method": "weighted_median_stable_threshold_segments",
                "candidate_count": len(hr_candidates),
            }
            evidence.extend(hr_evidence)

    return RunningCalibrationSnapshot(
        as_of_date=as_of_date,
        threshold_hr=_round(threshold_hr),
        threshold_speed_mps=_round(threshold_speed),
        threshold_hr_confidence=hr_confidence,
        threshold_speed_confidence=speed_confidence,
        rhr_baseline=None,
        hrmax_estimate=_estimate_hrmax(recent),
        source=source,
        evidence=tuple(evidence),
    )


def _round(value: float | None) -> float | None:
    return None if value is None else round(float(value), 4)


def _estimate_hrmax(history: Sequence[RunningActivity]) -> float | None:
    values: list[float] = []
    for activity in history:
        if activity.max_hr is not None and 80 <= float(activity.max_hr) <= 230:
            values.append(float(activity.max_hr))
        values.extend(
            float(sample.heart_rate_bpm)
            for sample in activity.samples
            if sample.heart_rate_bpm is not None and 80 <= float(sample.heart_rate_bpm) <= 230
        )
    if not values:
        return None
    values.sort()
    index = max(0, min(len(values) - 1, int(round((len(values) - 1) * 0.98))))
    return values[index]


def _observed_activity_hrmax(history: Sequence[RunningActivity]) -> float | None:
    values = [float(a.max_hr) for a in history if a.max_hr is not None and 80 <= float(a.max_hr) <= 230]
    return max(values) if values else None


def _estimate_threshold_speed(
    candidates: Sequence[SpeedCandidate],
) -> tuple[float | None, CalibrationConfidence, list[CalibrationEvidence]]:
    if not candidates:
        return None, CalibrationConfidence.NONE, []

    best_by_duration: dict[float, SpeedCandidate] = {}
    for candidate in candidates:
        bucket = float(min(BEST_EFFORT_DURATIONS_S, key=lambda d: abs(d - candidate.duration_s)))
        existing = best_by_duration.get(bucket)
        if existing is None or candidate.avg_speed_mps > existing.avg_speed_mps:
            best_by_duration[bucket] = candidate

    if 60 * 60 in best_by_duration:
        best_60 = best_by_duration[60 * 60]
        confidence = CalibrationConfidence.HIGH if best_60.confidence == CalibrationConfidence.HIGH else CalibrationConfidence.MEDIUM
        return best_60.avg_speed_mps, confidence, [evidence_from_speed(best_60)]

    if len(best_by_duration) >= 2:
        curve_speed = _critical_speed_curve(best_by_duration)
        if curve_speed is not None:
            evidence = [evidence_from_speed(c) for _, c in sorted(best_by_duration.items())]
            confidence = CalibrationConfidence.HIGH if _has_long_high_quality(best_by_duration) else CalibrationConfidence.MEDIUM
            return curve_speed, confidence, evidence

    longest = max(best_by_duration.values(), key=lambda c: c.duration_s)
    if longest.duration_s >= 20 * 60:
        # Riegel-style extrapolation toward one-hour threshold. This is
        # intentionally conservative for 20-45 minute efforts.
        adjusted = longest.avg_speed_mps * (longest.duration_s / (60 * 60)) ** 0.06
        confidence = CalibrationConfidence.MEDIUM if longest.duration_s >= 30 * 60 else CalibrationConfidence.LOW
        return adjusted, confidence, [evidence_from_speed(longest)]
    return None, CalibrationConfidence.NONE, []


def _has_long_high_quality(best_by_duration: dict[float, SpeedCandidate]) -> bool:
    return any(
        duration >= 45 * 60 and candidate.confidence == CalibrationConfidence.HIGH
        for duration, candidate in best_by_duration.items()
    )


def _critical_speed_curve(best_by_duration: dict[float, SpeedCandidate]) -> float | None:
    points = sorted((duration, c.avg_speed_mps * duration) for duration, c in best_by_duration.items())
    if len(points) < 2:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    x_bar = sum(xs) / len(xs)
    y_bar = sum(ys) / len(ys)
    denom = sum((x - x_bar) ** 2 for x in xs)
    if denom <= 0:
        return None
    slope = sum((x - x_bar) * (y - y_bar) for x, y in zip(xs, ys)) / denom
    if not math.isfinite(slope) or slope <= 0:
        return None
    if slope > max(c.avg_speed_mps for c in best_by_duration.values()):
        return None
    # Blend with the 60-minute projection so sparse short efforts do not
    # overstate threshold speed from the critical-speed intercept model.
    longest = max(best_by_duration.values(), key=lambda c: c.duration_s)
    projected = longest.avg_speed_mps * (longest.duration_s / (60 * 60)) ** 0.06
    return min(projected, max(slope, 0.9 * projected))


def _estimate_threshold_hr(
    candidates: Sequence[ThresholdHrCandidate],
    *,
    hrmax_estimate: float | None = None,
) -> tuple[float | None, CalibrationConfidence, list[CalibrationEvidence]]:
    if not candidates:
        return None, CalibrationConfidence.NONE, []
    candidates = _filter_hrmax_plausible(candidates, hrmax_estimate)
    if not candidates:
        return None, CalibrationConfidence.NONE, []
    candidates = _filter_hr_outliers(candidates)
    if not candidates:
        return None, CalibrationConfidence.NONE, []
    weights: list[tuple[float, float]] = []
    evidence: list[CalibrationEvidence] = []
    for candidate in candidates:
        weight = candidate.duration_s / 60.0
        if candidate.confidence == CalibrationConfidence.HIGH:
            weight *= 1.5
        weights.append((candidate.avg_hr, weight))
        evidence.append(evidence_from_hr(candidate))
    value = weighted_median(weights)
    high_count = sum(c.confidence == CalibrationConfidence.HIGH for c in candidates)
    if high_count >= 1:
        confidence = CalibrationConfidence.HIGH
    elif candidates:
        confidence = CalibrationConfidence.MEDIUM
    else:
        confidence = CalibrationConfidence.NONE
    return value, confidence, evidence


def _filter_hrmax_plausible(
    candidates: Sequence[ThresholdHrCandidate], hrmax_estimate: float | None,
) -> list[ThresholdHrCandidate]:
    if hrmax_estimate is None or hrmax_estimate <= 0:
        return list(candidates)
    low = 0.82 * float(hrmax_estimate)
    high = 0.94 * float(hrmax_estimate)
    filtered = [c for c in candidates if low <= float(c.avg_hr) <= high]
    return filtered or list(candidates)


def _filter_hr_outliers(candidates: Sequence[ThresholdHrCandidate]) -> list[ThresholdHrCandidate]:
    if len(candidates) < 3:
        return list(candidates)
    hrs = [float(c.avg_hr) for c in candidates]
    med = median(hrs)
    mad = median(abs(hr - med) for hr in hrs)
    threshold = max(8.0, 2.5 * max(1.4826 * mad, 3.0))
    filtered = [c for c in candidates if abs(float(c.avg_hr) - med) <= threshold]
    return filtered or list(candidates)
