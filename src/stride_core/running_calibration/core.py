"""Pure running threshold calibration algorithms."""

from __future__ import annotations

import math
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
from .types import (
    CalibrationConfidence,
    CalibrationEvidence,
    HrMaxProfile,
    RunningActivity,
    RunningCalibrationSnapshot,
    RunningHealthRow,
)

BEST_EFFORT_DURATIONS_S = (3 * 60, 5 * 60, 10 * 60, 20 * 60, 30 * 60, 45 * 60, 60 * 60)
THRESHOLD_HR_HRMAX_LOW_RATIO = 0.82
THRESHOLD_HR_HRMAX_HIGH_RATIO = 0.94
THRESHOLD_SPEED_MODEL_MIN_DURATION_S = 20 * 60
THRESHOLD_SPEED_LONG_ANCHOR_S = 45 * 60
THRESHOLD_SPEED_LONG_ANCHOR_CAP_RATIO = 1.02
THRESHOLD_SPEED_RIEGEL_EXPONENT = 0.06


def estimate_running_calibration(
    history: Sequence[RunningActivity], as_of_date: date,
) -> RunningCalibrationSnapshot:
    """Estimate running threshold speed, threshold HR, and supporting evidence.

    The function accepts only in-memory domain objects. Database fields,
    provider-specific units, and persistence are connector responsibilities.
    """
    recent = [a for a in history if as_of_date - timedelta(days=180) <= a.activity_date <= as_of_date]
    source: dict[str, object] = {"algorithm": "running_calibration_v3", "lookback_days": 180}
    evidence: list[CalibrationEvidence] = []
    hrmax_profile = estimate_hrmax_profile(recent)
    if hrmax_profile.source:
        source["hrmax_profile"] = hrmax_profile.source

    speed_candidates = best_speed_candidates(recent, BEST_EFFORT_DURATIONS_S)
    threshold_speed, speed_confidence, speed_evidence = _estimate_threshold_speed(speed_candidates)
    if threshold_speed is not None:
        source["threshold_speed"] = {
            "method": "best_efforts_upper_envelope_model",
            "candidate_count": len(speed_candidates),
        }
        evidence.extend(speed_evidence)

    threshold_hr = None
    hr_confidence = CalibrationConfidence.NONE
    if threshold_speed is not None:
        hr_candidates = stable_threshold_hr_candidates(recent, threshold_speed)
        threshold_hr, hr_confidence, hr_evidence = _estimate_threshold_hr(
            hr_candidates,
            hrmax_estimate=hrmax_profile.estimated_hrmax,
            hrmax_confidence=hrmax_profile.confidence,
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
        observed_max_hr=_round(hrmax_profile.observed_max_hr),
        hrmax_estimate=_round(hrmax_profile.estimated_hrmax),
        hrmax_confidence=hrmax_profile.confidence,
        high_hr_reference=_round(hrmax_profile.high_hr_reference),
        source=source,
        evidence=tuple(evidence + list(hrmax_profile.evidence)),
    )


def _round(value: float | None) -> float | None:
    return None if value is None else round(float(value), 4)


def estimate_hrmax_profile(history: Sequence[RunningActivity]) -> HrMaxProfile:
    samples: list[tuple[float, str, RunningActivity]] = []
    for activity in history:
        supported_timeseries = _supported_timeseries_hr_values(activity)
        if _activity_max_hr_supported(activity, supported_timeseries):
            samples.append((float(activity.max_hr), "activity", activity))
        samples.extend((hr, "timeseries", activity) for hr in supported_timeseries)
    if not samples:
        return HrMaxProfile(
            source={"method": "observed_valid_max_with_distribution_reference", "sample_count": 0},
        )

    values = sorted(hr for hr, _, _ in samples)
    observed_max = values[-1]
    raw_observed_max = _raw_observed_max_hr(history)
    high_reference = _percentile_sorted(values, 0.98)
    near_max_activity_count = len({activity.label_id for hr, _, activity in samples if hr >= observed_max - 3.0})
    has_timeseries_max = any(hr == observed_max and source == "timeseries" for hr, source, _ in samples)
    has_activity_max = any(hr == observed_max and source == "activity" for hr, source, _ in samples)
    if len(values) >= 100 and near_max_activity_count >= 2:
        confidence = CalibrationConfidence.HIGH
    elif len(values) >= 20 and (has_timeseries_max or has_activity_max):
        confidence = CalibrationConfidence.MEDIUM
    else:
        confidence = CalibrationConfidence.LOW

    max_activity = max((item[2] for item in samples if item[0] == observed_max), key=lambda a: a.activity_date)
    evidence = (
        CalibrationEvidence(
            kind="observed_max_hr",
            label_id=max_activity.label_id,
            activity_date=max_activity.activity_date,
            avg_hr=observed_max,
            confidence=confidence,
            source={"method": "max_valid_hr_sample"},
        ),
    )
    return HrMaxProfile(
        observed_max_hr=observed_max,
        estimated_hrmax=observed_max,
        confidence=confidence,
        high_hr_reference=high_reference,
        sample_count=len(values),
        evidence=evidence,
        source={
            "method": "observed_valid_max_with_distribution_reference",
            "observed_max_hr": observed_max,
            "raw_observed_max_hr": raw_observed_max,
            "estimated_hrmax": observed_max,
            "confidence": confidence.value,
            "high_hr_reference": high_reference,
            "sample_count": len(values),
            "near_max_activity_count": near_max_activity_count,
            "has_timeseries_max": has_timeseries_max,
            "has_activity_max": has_activity_max,
        },
    )


def _supported_timeseries_hr_values(activity: RunningActivity) -> list[float]:
    hrs: list[float | None] = []
    for sample in activity.samples:
        hr = sample.heart_rate_bpm
        hrs.append(float(hr) if hr is not None and 80 <= float(hr) <= 230 else None)
    out: list[float] = []
    for i, hr in enumerate(hrs):
        if hr is None:
            continue
        neighbor_values = [v for v in hrs[max(0, i - 2) : i] + hrs[i + 1 : i + 3] if v is not None]
        supported_by_neighbor = any(abs(hr - v) <= 5.0 for v in neighbor_values)
        if supported_by_neighbor:
            out.append(hr)
    return out


def _activity_max_hr_supported(activity: RunningActivity, supported_timeseries: Sequence[float]) -> bool:
    if activity.max_hr is None or not (80 <= float(activity.max_hr) <= 230):
        return False
    if not activity.samples:
        return True
    raw_hrs = [
        float(sample.heart_rate_bpm)
        for sample in activity.samples
        if sample.heart_rate_bpm is not None and 80 <= float(sample.heart_rate_bpm) <= 230
    ]
    if not raw_hrs:
        return True
    max_hr = float(activity.max_hr)
    raw_contains_summary_max = any(abs(max_hr - hr) <= 2.0 for hr in raw_hrs)
    if not raw_contains_summary_max:
        return True
    return any(abs(max_hr - hr) <= 2.0 for hr in supported_timeseries)


def _raw_observed_max_hr(history: Sequence[RunningActivity]) -> float | None:
    values: list[float] = []
    for activity in history:
        if activity.max_hr is not None and 80 <= float(activity.max_hr) <= 230:
            values.append(float(activity.max_hr))
        values.extend(
            float(sample.heart_rate_bpm)
            for sample in activity.samples
            if sample.heart_rate_bpm is not None and 80 <= float(sample.heart_rate_bpm) <= 230
        )
    return max(values) if values else None


def estimate_rhr_baseline(
    health_rows: Sequence[RunningHealthRow],
    *,
    as_of_date: date,
    lookback_days: int = 90,
    min_samples: int = 14,
) -> float | None:
    """P10 of recent valid daily-RHR samples.

    Returns None when fewer than `min_samples` valid rows fall inside the
    window. Mirrors the algorithm previously inlined in
    `training_load.calibration.estimate_calibration`,
    `routes/health.py::get_health`, and `coach_agent/context.py::_rhr_baseline`
    — those three sites now read this single implementation.
    """
    window_start = as_of_date - timedelta(days=lookback_days)
    values = sorted(
        float(row.rhr)
        for row in health_rows
        if row.rhr is not None
        and float(row.rhr) > 0
        and window_start <= row.date <= as_of_date
    )
    if len(values) < min_samples:
        return None
    idx = max(0, min(len(values) - 1, round((len(values) - 1) * 0.10)))
    return values[idx]


def _percentile_sorted(values: Sequence[float], pct: float) -> float | None:
    if not values:
        return None
    index = max(0, min(len(values) - 1, int(round((len(values) - 1) * pct))))
    return float(values[index])


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
        if best_60.confidence == CalibrationConfidence.HIGH and best_60.source == "timeseries":
            return best_60.avg_speed_mps, CalibrationConfidence.HIGH, [evidence_from_speed(best_60)]

    if len(best_by_duration) >= 2:
        model_speed = _threshold_speed_model(best_by_duration)
        if model_speed is not None:
            evidence = [evidence_from_speed(c) for _, c in sorted(best_by_duration.items())]
            confidence = CalibrationConfidence.HIGH if _has_long_high_quality(best_by_duration) else CalibrationConfidence.MEDIUM
            return model_speed, confidence, evidence

    longest = max(best_by_duration.values(), key=lambda c: c.duration_s)
    if longest.duration_s >= 20 * 60:
        # Riegel-style extrapolation toward one-hour threshold. This is
        # intentionally conservative for 20-45 minute efforts.
        adjusted = _riegel_threshold_projection(longest)
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
    projected = _riegel_threshold_projection(longest)
    return min(projected, max(slope, 0.9 * projected))


def _threshold_speed_model(best_by_duration: dict[float, SpeedCandidate]) -> float | None:
    projections = _threshold_speed_projections(best_by_duration)
    if projections:
        # Why: historical best efforts are one-sided observations. Non-maximal
        # workouts bias slow, while GPS spikes are already filtered upstream.
        speed = _weighted_quantile(projections, 0.75)
        long_anchor = max(
            (value for value, _, duration in projections if duration >= THRESHOLD_SPEED_LONG_ANCHOR_S),
            default=None,
        )
        if speed is not None and long_anchor is not None:
            speed = min(speed, long_anchor * THRESHOLD_SPEED_LONG_ANCHOR_CAP_RATIO)
        if speed is not None:
            curve_speed = _critical_speed_curve(best_by_duration)
            return max(speed, curve_speed) if curve_speed is not None else speed
    return _critical_speed_curve(best_by_duration)


def _threshold_speed_projections(best_by_duration: dict[float, SpeedCandidate]) -> list[tuple[float, float, float]]:
    projections: list[tuple[float, float, float]] = []
    for candidate in best_by_duration.values():
        if candidate.duration_s < THRESHOLD_SPEED_MODEL_MIN_DURATION_S:
            continue
        speed = _riegel_threshold_projection(candidate)
        if not math.isfinite(speed) or speed <= 0:
            continue
        weight = math.sqrt(max(candidate.duration_s, 1.0) / (60 * 60))
        if candidate.confidence == CalibrationConfidence.HIGH:
            weight *= 1.5
        elif candidate.confidence == CalibrationConfidence.LOW:
            weight *= 0.6
        if candidate.source == "timeseries":
            weight *= 1.15
        projections.append((speed, weight, candidate.duration_s))
    return projections


def _riegel_threshold_projection(candidate: SpeedCandidate) -> float:
    duration = max(float(candidate.duration_s), 1.0)
    return float(candidate.avg_speed_mps) * (duration / (60 * 60)) ** THRESHOLD_SPEED_RIEGEL_EXPONENT


def _weighted_quantile(values: Sequence[tuple[float, float, float]], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted((float(value), max(0.0, float(weight))) for value, weight, _ in values)
    total = sum(weight for _, weight in ordered)
    if total <= 0:
        return median(value for value, _ in ordered)
    target = total * max(0.0, min(1.0, quantile))
    acc = 0.0
    for value, weight in ordered:
        acc += weight
        if acc >= target:
            return value
    return ordered[-1][0]


def _estimate_threshold_hr(
    candidates: Sequence[ThresholdHrCandidate],
    *,
    hrmax_estimate: float | None = None,
    hrmax_confidence: CalibrationConfidence = CalibrationConfidence.NONE,
) -> tuple[float | None, CalibrationConfidence, list[CalibrationEvidence]]:
    if not candidates:
        return None, CalibrationConfidence.NONE, []
    candidates = _filter_hrmax_plausible(candidates, hrmax_estimate, hrmax_confidence)
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
    candidates: Sequence[ThresholdHrCandidate],
    hrmax_estimate: float | None,
    hrmax_confidence: CalibrationConfidence = CalibrationConfidence.NONE,
) -> list[ThresholdHrCandidate]:
    if hrmax_estimate is None or hrmax_estimate <= 0 or hrmax_confidence == CalibrationConfidence.NONE:
        return list(candidates)
    # Why: threshold HR should sit below near-max race HR while staying above
    # easy aerobic HR; this catches optical lock/dropout segments.
    low = THRESHOLD_HR_HRMAX_LOW_RATIO * float(hrmax_estimate)
    high = THRESHOLD_HR_HRMAX_HIGH_RATIO * float(hrmax_estimate)
    above_low = [c for c in candidates if float(c.avg_hr) >= low]
    if not above_low:
        return []
    within_band = [c for c in above_low if float(c.avg_hr) <= high]
    return within_band or above_low


def _filter_hr_outliers(candidates: Sequence[ThresholdHrCandidate]) -> list[ThresholdHrCandidate]:
    if len(candidates) < 3:
        return list(candidates)
    hrs = [float(c.avg_hr) for c in candidates]
    med = median(hrs)
    mad = median(abs(hr - med) for hr in hrs)
    threshold = max(8.0, 2.5 * max(1.4826 * mad, 3.0))
    filtered = [c for c in candidates if abs(float(c.avg_hr) - med) <= threshold]
    return filtered or list(candidates)
