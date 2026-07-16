"""Pure objective training-load algorithms."""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, timedelta
from statistics import median
from typing import Iterable, Sequence

from ..workout_spec import (
    DurationKind,
    NormalizedRunWorkout,
    StepKind,
    TargetKind,
    WorkoutStep,
)
from .types import (
    TRAINING_LOAD_MODEL_VERSION,
    ActivityLoadInput,
    ActivityLoadResult,
    ActivitySample,
    CalibrationSnapshot,
    DailyLoadResult,
    FeedbackRow,
    HealthRow,
    HrvRow,
    LoadConfidence,
    LoadCoverageStatus,
    PlannedLoadEstimate,
    PriorLoadState,
    SessionClass,
)

_RUNNING_SPORTS = {"run", "run_outdoor", "run_indoor", "run_trail", "run_track", "run_treadmill"}
_CARDIO_HRR_EXPONENT = 4.0
_EXTERNAL_NORMALIZATION_EXPONENT = 6.0
_HIGH_INTENSITY_SPEED_SMOOTHING_SECONDS = 20.0
_HIGH_INTENSITY_WORK_IF = 1.05
_HIGH_INTENSITY_MIN_WORK_SECONDS = 60.0
_HIGH_INTENSITY_RECOVERY_IF = 0.90
_HIGH_INTENSITY_RECOVERY_HR_IF = 0.85
_HIGH_INTENSITY_RECOVERY_WINDOW_SECONDS = 120.0
_HIGH_INTENSITY_ARM_WINDOW_SECONDS = 240.0
_HIGH_INTENSITY_RECOVERY_WEIGHT = 50.0
_HIGH_INTENSITY_SEVERITY_WEIGHT = 100.0
_HIGH_INTENSITY_SEVERITY_EXPONENT = 4.0
_HIGH_INTENSITY_MAX_TSS_PER_HOUR = 75.0


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _round(value: float | None) -> float | None:
    return None if value is None else round(float(value), 4)


def _duration_minutes(activity: ActivityLoadInput) -> float | None:
    if activity.duration_s and activity.duration_s > 0:
        return float(activity.duration_s) / 60.0
    if len(activity.samples) >= 2:
        start = _sample_time(activity.samples[0], 0)
        end = _sample_time(activity.samples[-1], len(activity.samples) - 1)
        if end > start:
            return (end - start) / 60.0
    return None


def _sample_time(sample: ActivitySample, index: int) -> float:
    if sample.elapsed_s is not None:
        return float(sample.elapsed_s)
    if sample.timestamp_s is not None:
        return float(sample.timestamp_s)
    return float(index)


def _explicit_sample_time(sample: ActivitySample) -> float | None:
    if sample.elapsed_s is not None:
        return float(sample.elapsed_s)
    if sample.timestamp_s is not None:
        return float(sample.timestamp_s)
    return None


def _valid_sample_intervals(
    samples: Sequence[ActivitySample],
    *,
    max_gap_s: float = 300.0,
) -> list[tuple[int, float]]:
    """Return ``(ending_sample_index, dwell_seconds)`` from real timestamps.

    Load integration must be invariant to device sampling density.  Each value
    is therefore weighted by the time since the previous sample; missing,
    duplicate, backwards, or pause-sized gaps are never invented or expanded.
    """
    intervals: list[tuple[int, float]] = []
    for index in range(1, len(samples)):
        current = _explicit_sample_time(samples[index])
        previous = _explicit_sample_time(samples[index - 1])
        if current is None or previous is None:
            continue
        delta = current - previous
        if 0 < delta <= max_gap_s:
            intervals.append((index, delta))
    return intervals


def _coverage_status(*coverages: float) -> LoadCoverageStatus:
    coverage = max(coverages, default=0.0)
    if coverage >= 0.8:
        return LoadCoverageStatus.COMPLETE
    if coverage > 0:
        return LoadCoverageStatus.PARTIAL
    return LoadCoverageStatus.UNKNOWN


def _confidence_for_coverage(coverage: float) -> LoadConfidence:
    if coverage >= 0.8:
        return LoadConfidence.HIGH
    if coverage >= 0.5:
        return LoadConfidence.MEDIUM
    if coverage > 0:
        return LoadConfidence.LOW
    return LoadConfidence.NONE


def _clean_hr_values(samples: Sequence[ActivitySample]) -> list[float | None]:
    raw: list[float | None] = []
    for sample in samples:
        hr = sample.heart_rate_bpm
        if hr is None:
            raw.append(None)
            continue
        hr = float(hr)
        raw.append(hr if 30 <= hr <= 230 else None)

    clean = list(raw)
    for i in range(1, len(raw) - 1):
        cur, prev, nxt = raw[i], raw[i - 1], raw[i + 1]
        if cur is None or prev is None or nxt is None:
            continue
        if abs(cur - prev) > 12 and abs(cur - nxt) > 12 and abs(prev - nxt) <= 12:
            clean[i] = None
    return clean


def _banister_trimp(hrr: float, minutes: float) -> float:
    # STRIDE's provider-neutral internal-load response.  The classic 1.92
    # coefficient is too flat for modern running data: short near-max efforts
    # become almost indistinguishable from steady aerobic work.  A steeper
    # curve preserves dwell-by-dwell detail while the threshold normalization
    # below still pins one hour at this athlete's LTHR to exactly 100.
    return minutes * hrr * math.exp(_CARDIO_HRR_EXPONENT * hrr)


def _compute_cardio_load(
    activity: ActivityLoadInput, calibration: CalibrationSnapshot
) -> tuple[float | None, float | None, list[str], LoadConfidence, float]:
    if not activity.samples:
        return None, None, ["heart_rate_missing"], LoadConfidence.NONE, 0.0
    rhr = calibration.rhr_baseline
    hrmax = calibration.hrmax_estimate
    if rhr is None or hrmax is None or hrmax <= rhr:
        return None, None, ["hr_calibration_missing"], LoadConfidence.NONE, 0.0

    clean_hr = _clean_hr_values(activity.samples)
    valid = [hr for hr in clean_hr if hr is not None]
    if not valid:
        return None, None, ["heart_rate_missing"], LoadConfidence.NONE, 0.0

    raw = 0.0
    covered_minutes = 0.0
    sampled_minutes = 0.0
    for i, delta_s in _valid_sample_intervals(activity.samples):
        minutes = delta_s / 60.0
        sampled_minutes += minutes
        hr = clean_hr[i]
        if hr is None or minutes <= 0:
            continue
        covered_minutes += minutes
        hrr = _clamp((hr - rhr) / (hrmax - rhr), 0.0, 1.05)
        raw += _banister_trimp(hrr, minutes)

    duration_min = _duration_minutes(activity) or sampled_minutes
    coverage = (
        _clamp(covered_minutes / duration_min, 0.0, 1.0)
        if duration_min and duration_min > 0
        else 0.0
    )
    confidence = _confidence_for_coverage(coverage)
    reasons: list[str] = []
    if coverage < 0.8:
        reasons.append("heart_rate_low_coverage")

    threshold_hr = calibration.threshold_hr
    if threshold_hr is None:
        reasons.append("threshold_hr_missing")
        return _round(raw), None, reasons, confidence, _round(coverage) or 0.0

    threshold_hrr = (threshold_hr - rhr) / (hrmax - rhr)
    if threshold_hrr <= 0:
        reasons.append("threshold_hr_invalid")
        return _round(raw), None, reasons, confidence, _round(coverage) or 0.0

    threshold_trimp_1h = _banister_trimp(_clamp(threshold_hrr, 0.0, 1.05), 60.0)
    if threshold_trimp_1h <= 0:
        reasons.append("threshold_hr_invalid")
        return _round(raw), None, reasons, confidence, _round(coverage) or 0.0
    cardio_tss = 100.0 * raw / threshold_trimp_1h
    return _round(raw), _round(cardio_tss), reasons, confidence, _round(coverage) or 0.0


def _series_values(samples: Sequence[ActivitySample], field: str) -> list[float]:
    values: list[float] = []
    for sample in samples:
        value = getattr(sample, field)
        if value is not None:
            values.append(float(value))
    return values


def _distance_window_grade(samples: Sequence[ActivitySample], index: int) -> float | None:
    cur = samples[index]
    if cur.distance_m is None or cur.altitude_m is None:
        return None
    lo = hi = index
    while lo > 0:
        other = samples[lo - 1]
        if other.distance_m is None or cur.distance_m - other.distance_m > 50:
            break
        lo -= 1
    while hi < len(samples) - 1:
        other = samples[hi + 1]
        if other.distance_m is None or other.distance_m - cur.distance_m > 50:
            break
        hi += 1
    first, last = samples[lo], samples[hi]
    if first.distance_m is None or last.distance_m is None:
        return None
    if first.altitude_m is None or last.altitude_m is None:
        return None
    dist = last.distance_m - first.distance_m
    if dist < 20:
        return None
    return _clamp((last.altitude_m - first.altitude_m) / dist, -0.2, 0.2)


def _grade_adjusted_speed(speed: float, grade: float | None) -> float:
    if grade is None:
        return speed
    factor = max(0.7, 1.0 + 3.0 * grade)
    factor = min(1.5, factor)
    return max(0.0, speed * factor)


def _compute_external_tss(
    activity: ActivityLoadInput, calibration: CalibrationSnapshot
) -> tuple[float | None, list[str], LoadConfidence, float | None, float]:
    samples = activity.samples
    if not samples:
        return None, ["external_samples_missing"], LoadConfidence.NONE, None, 0.0
    if not _is_running(activity.sport):
        return None, ["external_not_supported_for_sport"], LoadConfidence.NONE, None, 0.0

    use_speed = bool(calibration.threshold_speed_mps and calibration.threshold_speed_mps > 0)
    reasons: list[str] = []
    if not use_speed:
        reasons.append("external_calibration_missing")
        return None, reasons, LoadConfidence.NONE, None, 0.0

    duration_min = _duration_minutes(activity)
    if duration_min is None or duration_min <= 0:
        reasons.append("duration_missing")
        return None, reasons, LoadConfidence.NONE, None, 0.0

    altitude_present = len(_series_values(samples, "altitude_m")) / len(samples) >= 0.8
    distance_present = len(_series_values(samples, "distance_m")) / len(samples) >= 0.8
    grade_ok = altitude_present and distance_present
    if not grade_ok:
        reasons.append("grade_unavailable_flat_speed")

    weighted_if_power = 0.0
    covered_seconds = 0.0
    for i, delta_s in _valid_sample_intervals(samples):
        speed = samples[i].speed_mps
        if speed is None or speed <= 0:
            continue
        grade = _distance_window_grade(samples, i) if grade_ok else None
        adjusted = _grade_adjusted_speed(float(speed), grade)
        intensity = _clamp(adjusted / float(calibration.threshold_speed_mps), 0.0, 2.0)
        weighted_if_power += delta_s * intensity**_EXTERNAL_NORMALIZATION_EXPONENT
        covered_seconds += delta_s

    if covered_seconds <= 0:
        reasons.append("external_samples_missing")
        return None, reasons, LoadConfidence.NONE, None, 0.0

    # Integrate only observed dwell.  A ten-minute trace attached to a
    # sixty-minute summary remains a ten-minute load; it is never multiplied
    # up to the summary duration.
    normalized_if = (
        weighted_if_power / covered_seconds
    ) ** (1.0 / _EXTERNAL_NORMALIZATION_EXPONENT)
    tss = 100.0 * (covered_seconds / 3600.0) * normalized_if**2
    coverage = _clamp(covered_seconds / (duration_min * 60.0), 0.0, 1.0)
    confidence = _confidence_for_coverage(coverage)
    if coverage < 0.8:
        reasons.append("external_low_coverage")
    return _round(tss), reasons, confidence, _round(normalized_if), _round(coverage) or 0.0


def _compute_high_intensity_tss(
    activity: ActivityLoadInput,
    calibration: CalibrationSnapshot,
) -> tuple[float | None, list[str], LoadConfidence, float]:
    """Estimate the extra metabolic cost visible only after execution.

    Ordinary cardio/external TSS integrates intensity dwell but cannot fully
    distinguish a steady run from repeated hard work with incomplete active
    recovery. This channel detects sustained supra-threshold work from a
    smoothed speed trace, then measures how much HR remains elevated during
    the following low-speed recovery. It deliberately uses no session label
    or vendor training-load/effect field.

    The result is a supplement on the shared TSS scale. It is available only
    when both HR and speed cover the activity; planned workouts cannot use it
    because post-work recovery HR is not known before execution.
    """
    if not activity.samples:
        return None, ["high_intensity_samples_missing"], LoadConfidence.NONE, 0.0
    if not _is_running(activity.sport):
        return None, ["high_intensity_not_supported_for_sport"], LoadConfidence.NONE, 0.0

    rhr = calibration.rhr_baseline
    hrmax = calibration.hrmax_estimate
    threshold_hr = calibration.threshold_hr
    threshold_speed = calibration.threshold_speed_mps
    if (
        rhr is None
        or hrmax is None
        or hrmax <= rhr
        or threshold_hr is None
        or threshold_speed is None
        or threshold_speed <= 0
    ):
        return None, ["high_intensity_calibration_missing"], LoadConfidence.NONE, 0.0

    threshold_hrr = (threshold_hr - rhr) / (hrmax - rhr)
    if threshold_hrr <= 0:
        return None, ["high_intensity_calibration_invalid"], LoadConfidence.NONE, 0.0

    duration_min = _duration_minutes(activity)
    if duration_min is None or duration_min <= 0:
        return None, ["duration_missing"], LoadConfidence.NONE, 0.0

    clean_hr = _clean_hr_values(activity.samples)
    covered_seconds = 0.0
    threshold_hr_seconds = 0.0
    recovery_residual_tss = 0.0
    smoothed_if: float | None = None
    peak_smoothed_if = 0.0
    recovery_armed = False
    work_seconds = 0.0
    recovery_seconds = 0.0
    armed_seconds = 0.0

    for index, delta_s in _valid_sample_intervals(activity.samples):
        hr = clean_hr[index]
        speed = activity.samples[index].speed_mps
        if hr is None or speed is None or speed <= 0:
            continue
        covered_seconds += delta_s

        hrr = _clamp((hr - rhr) / (hrmax - rhr), 0.0, 1.05)
        hr_if = hrr / threshold_hrr
        raw_speed_if = _clamp(float(speed) / float(threshold_speed), 0.0, 2.0)
        alpha = 1.0 - math.exp(-delta_s / _HIGH_INTENSITY_SPEED_SMOOTHING_SECONDS)
        smoothed_if = (
            raw_speed_if
            if smoothed_if is None
            else smoothed_if + alpha * (raw_speed_if - smoothed_if)
        )
        peak_smoothed_if = max(peak_smoothed_if, smoothed_if)
        if hr_if >= 1.0:
            threshold_hr_seconds += delta_s

        if smoothed_if >= _HIGH_INTENSITY_WORK_IF:
            work_seconds += delta_s
            recovery_seconds = 0.0
            armed_seconds = 0.0
            if work_seconds >= _HIGH_INTENSITY_MIN_WORK_SECONDS:
                recovery_armed = True
        elif recovery_armed:
            armed_seconds += delta_s
            if smoothed_if <= _HIGH_INTENSITY_RECOVERY_IF:
                recovery_seconds += delta_s
                recovery_residual_tss += (
                    100.0
                    * delta_s
                    / 3600.0
                    * max(hr_if - _HIGH_INTENSITY_RECOVERY_HR_IF, 0.0)
                )
            else:
                recovery_seconds = 0.0
            if (
                recovery_seconds >= _HIGH_INTENSITY_RECOVERY_WINDOW_SECONDS
                or armed_seconds >= _HIGH_INTENSITY_ARM_WINDOW_SECONDS
                or hr_if < _HIGH_INTENSITY_RECOVERY_HR_IF
            ):
                recovery_armed = False
                work_seconds = 0.0
                recovery_seconds = 0.0
                armed_seconds = 0.0
        elif not recovery_armed:
            # A short GPS/pace excursion cannot arm recovery. Decay partial
            # work quickly so separate non-qualifying bursts do not combine.
            work_seconds = max(0.0, work_seconds - 2.0 * delta_s)

    coverage = _clamp(covered_seconds / (duration_min * 60.0), 0.0, 1.0)
    confidence = _confidence_for_coverage(coverage)
    reasons: list[str] = []
    if coverage < 0.8:
        reasons.append("high_intensity_low_coverage")
        return None, reasons, confidence, _round(coverage) or 0.0

    if recovery_residual_tss <= 0:
        return 0.0, reasons, confidence, _round(coverage) or 0.0

    # Convert the post-work recovery residual to the common TSS scale. The
    # second term is a severe-session EPOC proxy: it activates only when a
    # 20-second-smoothed peak exceeds threshold and HR also spends time above
    # LTHR. A fourth power separates short VO2/anaerobic work from ordinary
    # threshold running without reacting to one-sample GPS spikes.
    peak_excess = max(peak_smoothed_if - 1.0, 0.0)
    threshold_hr_minutes = threshold_hr_seconds / 60.0
    supplement = recovery_residual_tss * (
        _HIGH_INTENSITY_RECOVERY_WEIGHT
        + _HIGH_INTENSITY_SEVERITY_WEIGHT
        * peak_excess**_HIGH_INTENSITY_SEVERITY_EXPONENT
        * threshold_hr_minutes
    )
    supplement = min(
        supplement,
        _HIGH_INTENSITY_MAX_TSS_PER_HOUR * covered_seconds / 3600.0,
    )
    return _round(supplement), reasons, confidence, _round(coverage) or 0.0


def _compute_mechanical_load(activity: ActivityLoadInput, normalized_if: float | None) -> float | None:
    if not activity.distance_m or activity.distance_m <= 0:
        return None
    distance_km = float(activity.distance_m) / 1000.0
    if distance_km <= 0:
        return None
    ascent_m_per_km = max(0.0, float(activity.ascent_m or 0.0) / distance_km)
    descent_m_per_km = max(0.0, float(activity.descent_m or 0.0) / distance_km)
    grade_factor = min(1.5, 1.0 + 0.006 * ascent_m_per_km)
    descent_factor = min(1.4, 1.0 + 0.004 * max(0.0, descent_m_per_km - 20.0))
    intensity = normalized_if if normalized_if is not None else 0.75
    intensity_factor = min(1.4, 1.0 + 0.5 * max(0.0, intensity - 0.85) ** 2)
    return _round(distance_km * grade_factor * descent_factor * intensity_factor)


def _is_running(sport: str) -> bool:
    sport = (sport or "").lower()
    return sport in _RUNNING_SPORTS or sport.startswith("run_")


def _confidence_from_parts(*parts: LoadConfidence) -> LoadConfidence:
    usable = [p for p in parts if p != LoadConfidence.NONE]
    if not usable:
        return LoadConfidence.NONE
    if any(p == LoadConfidence.LOW for p in usable):
        return LoadConfidence.LOW
    if any(p == LoadConfidence.MEDIUM for p in usable):
        return LoadConfidence.MEDIUM
    return LoadConfidence.HIGH


def compute_activity_load(
    activity: ActivityLoadInput, calibration: CalibrationSnapshot
) -> ActivityLoadResult:
    """Compute objective TSS-like load for one activity.

    Raw TRIMP, mechanical load, and sRPE remain side-channel signals unless
    they can be normalized to the shared TSS-like scale.
    """
    duration_min = _duration_minutes(activity)
    subjective = None
    if activity.rpe is not None and duration_min is not None:
        subjective = float(activity.rpe) * duration_min

    cardio_raw, cardio_tss, cardio_reasons, cardio_conf, cardio_coverage = _compute_cardio_load(activity, calibration)
    external_tss, external_reasons, external_conf, normalized_if, external_coverage = _compute_external_tss(activity, calibration)
    high_intensity_tss, high_intensity_reasons, high_intensity_conf, high_intensity_coverage = (
        _compute_high_intensity_tss(activity, calibration)
    )
    mechanical = _compute_mechanical_load(activity, normalized_if)

    reasons = list(cardio_reasons)
    reasons.extend(r for r in external_reasons if r != "grade_unavailable_flat_speed")
    reasons.extend(high_intensity_reasons)

    training_dose: float | None = None
    training_dose_source: str | None = None
    confidence = LoadConfidence.NONE
    # PMC needs one stable scalar. Prefer measured physiological response when
    # it covers the activity; use running external load only as a fallback.
    # The two channels remain persisted separately and are never mixed by a
    # session-type-specific magic weight.
    if (
        cardio_tss is not None
        and external_tss is not None
        and cardio_coverage >= 0.8
        and external_coverage >= 0.8
    ):
        # Both complete channels should agree directionally.  Use their
        # conservative envelope so a GPS burst or optical-HR spike cannot by
        # itself dominate PMC; unlike v1 this is data-quality fusion, not a
        # session-label-specific fixed blend.
        training_dose = min(cardio_tss, external_tss)
        training_dose_source = "conservative_fusion"
        confidence = _confidence_from_parts(cardio_conf, external_conf)
        if high_intensity_tss is not None and high_intensity_coverage >= 0.8:
            training_dose += high_intensity_tss
            if high_intensity_tss > 0:
                training_dose_source = "conservative_fusion+high_intensity"
            confidence = _confidence_from_parts(confidence, high_intensity_conf)
    elif cardio_tss is not None and cardio_coverage >= 0.8:
        training_dose = cardio_tss
        training_dose_source = "cardio"
        confidence = cardio_conf
    elif external_tss is not None and external_coverage >= 0.8:
        training_dose = external_tss
        training_dose_source = "external"
        confidence = external_conf
    elif cardio_tss is not None or external_tss is not None:
        reasons.append("objective_load_partial_coverage")

    if training_dose is None:
        reasons.append("no_tss_like_objective_load")

    compact_reasons = list(dict.fromkeys(reasons))
    return ActivityLoadResult(
        label_id=activity.label_id,
        activity_date=activity.activity_date,
        sport=activity.sport,
        session_class=activity.session_class,
        duration_minutes=_round(duration_min),
        algorithm_version=TRAINING_LOAD_MODEL_VERSION,
        calibration_id=calibration.id,
        cardio_load_raw=cardio_raw,
        cardio_tss=cardio_tss,
        external_tss=external_tss,
        high_intensity_tss=high_intensity_tss,
        mechanical_load=mechanical,
        subjective_internal_load=_round(subjective),
        training_dose=_round(training_dose),
        training_dose_source=training_dose_source,
        cardio_coverage=cardio_coverage,
        external_coverage=external_coverage,
        high_intensity_coverage=high_intensity_coverage,
        coverage_status=_coverage_status(cardio_coverage, external_coverage),
        load_confidence=confidence,
        excluded_from_pmc=training_dose is None,
        reasons=compact_reasons,
    )


# Explicit assumptions for non-work steps whose target is OPEN. They are only
# used for warm-up, cooldown, and active recovery; an OPEN work step stays
# unknown because its session intensity cannot be inferred from the role alone.
_OPEN_TARGET_DEFAULT_IF: dict[StepKind, float] = {
    StepKind.WARMUP: 0.78,
    StepKind.COOLDOWN: 0.78,
    StepKind.RECOVERY: 0.65,
}

# Passive rest has no running load. Active recovery is a real part of the
# session and is estimated from its own target (or the declared recovery
# assumption above).
_SKIPPED_PLANNED_STEPS = {StepKind.REST}


def _planned_step_intensity_range(
    step: WorkoutStep,
    threshold_speed_mps: float | None,
    threshold_hr: float | None,
    rhr: float | None,
) -> tuple[float, float, float, str | None] | None:
    target = step.target
    if target.kind == TargetKind.PACE_S_KM:
        if not threshold_speed_mps or threshold_speed_mps <= 0:
            return None
        if target.low is None or target.high is None:
            return None
        slow_pace = max(float(target.low), float(target.high))
        fast_pace = min(float(target.low), float(target.high))
        if slow_pace <= 0 or fast_pace <= 0:
            return None
        low = _clamp((1000.0 / slow_pace) / threshold_speed_mps, 0.0, 2.0)
        high = _clamp((1000.0 / fast_pace) / threshold_speed_mps, 0.0, 2.0)
        return low, (low + high) / 2.0, high, None
    if target.kind == TargetKind.HR_BPM:
        if not threshold_hr or rhr is None or threshold_hr <= rhr:
            return None
        if target.low is None or target.high is None:
            return None
        low_hr = min(float(target.low), float(target.high))
        high_hr = max(float(target.low), float(target.high))
        low = _clamp((low_hr - rhr) / (threshold_hr - rhr), 0.0, 2.0)
        high = _clamp((high_hr - rhr) / (threshold_hr - rhr), 0.0, 2.0)
        return low, (low + high) / 2.0, high, "heart_rate_target_used_as_intensity_proxy"
    if target.kind == TargetKind.POWER_W:
        return None
    default = _OPEN_TARGET_DEFAULT_IF.get(step.step_kind)
    if default is None:
        return None
    return default, default, default, f"open_{step.step_kind.value}_target_if_{default:.2f}"


def _planned_step_minutes(
    step: WorkoutStep, intensity: float, threshold_speed_mps: float | None
) -> float | None:
    """Duration of one planned step in minutes, or None if it can't be derived.

    Distance steps need a speed: `threshold_speed * intensity` reproduces the
    target pace exactly for pace steps and estimates it for HR/default steps.
    Open-duration steps return None (skipped).
    """
    duration = step.duration
    if duration.kind == DurationKind.TIME_S and duration.value and duration.value > 0:
        return float(duration.value) / 60.0
    if duration.kind == DurationKind.DISTANCE_M and duration.value and duration.value > 0:
        if threshold_speed_mps and threshold_speed_mps > 0:
            speed = float(threshold_speed_mps) * intensity
            if speed > 0:
                return (float(duration.value) / speed) / 60.0
    return None


def _dose_from_intensity_dwell(
    intervals: Sequence[tuple[float, float]],
) -> float | None:
    """Apply the measured external-load scale to planned minute/IF pairs."""
    total_minutes = sum(minutes for minutes, _intensity in intervals if minutes > 0)
    if total_minutes <= 0:
        return None
    weighted = sum(
        minutes * intensity**_EXTERNAL_NORMALIZATION_EXPONENT
        for minutes, intensity in intervals
        if minutes > 0
    )
    normalized_if = (weighted / total_minutes) ** (1.0 / _EXTERNAL_NORMALIZATION_EXPONENT)
    return 100.0 * (total_minutes / 60.0) * normalized_if**2


def estimate_planned_run_load(
    workout: NormalizedRunWorkout,
    *,
    threshold_speed_mps: float | None = None,
    threshold_hr: float | None = None,
    rhr: float | None = None,
) -> float | None:
    """Estimate STRIDE training_dose for a *planned* run workout.

    The estimate is on the same TSS-like scale as the actual load
    (`_compute_external_tss`): planned segments are time-weighted with the same
    normalized-IF exponent, then converted with
    ``dose = hours * normalized_IF**2 * 100``. A steady or variable-pace plan
    therefore uses the same scale as the eventual measured external channel.

    Intensity per step prefers a pace target (``speed / threshold_speed``),
    falls back to an HR target (``(hr - rhr) / (lthr - rhr)``, an IF² proxy for
    Banister TRIMP — adequate for the easy runs that carry HR-only targets),
    then to a visible role-based assumption for OPEN targets. Active RECOVERY
    steps are counted; passive REST and open-duration steps contribute nothing.
    Variable-pace sessions remain an estimate rather than a reconstruction of
    the athlete's eventual sample-by-sample response.

    Returns None when no step is computable (e.g. neither threshold speed nor
    HR calibration is available).
    """
    return estimate_planned_run_load_details(
        workout,
        threshold_speed_mps=threshold_speed_mps,
        threshold_hr=threshold_hr,
        rhr=rhr,
    ).expected_dose


def estimate_planned_run_load_details(
    workout: NormalizedRunWorkout,
    *,
    threshold_speed_mps: float | None = None,
    threshold_hr: float | None = None,
    rhr: float | None = None,
) -> PlannedLoadEstimate:
    """Estimate expected/range load for a structured planned run.

    Every active segment, including jog recoveries, is integrated separately.
    Explicit target ranges become load ranges; role-based OPEN targets are kept
    as visible assumptions.  No fixed athlete pace is introduced when a
    distance step cannot be converted with personal calibration.
    """
    total_minutes = 0.0
    total_distance_m = 0.0
    low_intervals: list[tuple[float, float]] = []
    expected_intervals: list[tuple[float, float]] = []
    high_intervals: list[tuple[float, float]] = []
    finite_steps = estimated_steps = unestimated_steps = 0
    assumptions: list[str] = []
    for block in workout.blocks:
        for _rep in range(block.repeat):
            for step in block.steps:
                if step.step_kind in _SKIPPED_PLANNED_STEPS:
                    continue
                if step.duration.kind != DurationKind.OPEN:
                    finite_steps += 1
                intensity_range = _planned_step_intensity_range(
                    step, threshold_speed_mps, threshold_hr, rhr
                )
                if intensity_range is None:
                    unestimated_steps += 1
                    continue
                low_if, expected_if, high_if, assumption = intensity_range
                minutes = _planned_step_minutes(step, expected_if, threshold_speed_mps)
                if minutes is None or minutes <= 0:
                    unestimated_steps += 1
                    continue
                estimated_steps += 1
                total_minutes += minutes
                if step.duration.kind == DurationKind.DISTANCE_M and step.duration.value:
                    total_distance_m += float(step.duration.value)
                    low_minutes = _planned_step_minutes(step, low_if, threshold_speed_mps) or minutes
                    high_minutes = _planned_step_minutes(step, high_if, threshold_speed_mps) or minutes
                elif threshold_speed_mps and threshold_speed_mps > 0:
                    total_distance_m += minutes * 60.0 * threshold_speed_mps * expected_if
                    low_minutes = high_minutes = minutes
                else:
                    low_minutes = high_minutes = minutes
                low_intervals.append((low_minutes, low_if))
                expected_intervals.append((minutes, expected_if))
                high_intervals.append((high_minutes, high_if))
                if assumption:
                    assumptions.append(assumption)

    coverage = estimated_steps / finite_steps if finite_steps else 0.0
    total_low = _dose_from_intensity_dwell(low_intervals)
    total_expected = _dose_from_intensity_dwell(expected_intervals)
    total_high = _dose_from_intensity_dwell(high_intervals)
    confidence = (
        LoadConfidence.HIGH
        if coverage >= 0.999 and not assumptions and not unestimated_steps
        else LoadConfidence.MEDIUM
        if coverage >= 0.8
        else LoadConfidence.LOW
        if estimated_steps
        else LoadConfidence.NONE
    )
    return PlannedLoadEstimate(
        expected_dose=_round(total_expected),
        low_dose=_round(total_low),
        high_dose=_round(total_high),
        estimated_duration_minutes=_round(total_minutes) if estimated_steps else None,
        estimated_distance_km=_round(total_distance_m / 1000.0) if estimated_steps else None,
        coverage=_round(coverage) or 0.0,
        confidence=confidence,
        assumptions=tuple(dict.fromkeys(assumptions)),
        unestimated_steps=unestimated_steps,
    )


def _daterange(start: date, end: date) -> Iterable[date]:
    day = start
    while day <= end:
        yield day
        day += timedelta(days=1)


def _values_before(rows: Sequence[tuple[date, float]], current: date, days: int) -> list[float]:
    lower = current - timedelta(days=days)
    return [v for d, v in rows if lower <= d < current]


def _mad(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    med = median(values)
    return median([abs(v - med) for v in values])


def _robust_scale(values: Sequence[float]) -> float:
    if not values:
        return 1.0
    med = median(values)
    return max(1.4826 * _mad(values), 3.0, 0.05 * med)


def _z(value: float, values: Sequence[float]) -> float:
    if not values:
        return 0.0
    scale = _robust_scale(values)
    return (value - median(values)) / scale if scale > 0 else 0.0


def _readiness_for_day(
    day: date,
    health_by_date: dict[date, HealthRow],
    hrv_by_date: dict[date, HrvRow],
    all_health: Sequence[HealthRow],
    all_hrv: Sequence[HrvRow],
    day_activities: Sequence[ActivityLoadResult],
    feedback_by_label: dict[str, FeedbackRow],
    history_by_class: dict[tuple[str, SessionClass], list[tuple[float, float]]],
) -> tuple[str, list[str]]:
    yellow = 0
    red = 0
    reasons: list[str] = []

    today_hrv = hrv_by_date.get(day)
    hrv_history = [
        (row.date, float(row.last_night_avg))
        for row in all_hrv
        if row.last_night_avg is not None
    ]
    if today_hrv is not None:
        status = (today_hrv.status or "").strip().lower()
        if status in {"poor", "low"}:
            red += 1
            reasons.append("low_hrv")
        elif today_hrv.last_night_avg is not None:
            baseline = _values_before(hrv_history, day, 28)
            if len(baseline) >= 14:
                med = median(baseline)
                scale = _robust_scale(baseline)
                value = float(today_hrv.last_night_avg)
                if value < med - 2.5 * scale:
                    red += 1
                    reasons.append("low_hrv")
                elif value < med - 1.5 * scale:
                    yellow += 1
                    reasons.append("low_hrv")

    today_health = health_by_date.get(day)
    rhr_history = [
        (row.date, float(row.rhr))
        for row in all_health
        if row.rhr is not None
    ]
    if today_health is not None and today_health.rhr is not None:
        baseline = _values_before(rhr_history, day, 90)
        if len(baseline) >= 14:
            sorted_vals = sorted(baseline)
            idx = max(0, min(len(sorted_vals) - 1, int((len(sorted_vals) - 1) * 0.1)))
            base = sorted_vals[idx]
            if today_health.rhr >= base + 8:
                red += 1
                reasons.append("rhr_elevated")
            elif today_health.rhr >= base + 5:
                yellow += 1
                reasons.append("rhr_elevated")
        if today_health.sleep_total_s is not None:
            sleep_h = float(today_health.sleep_total_s) / 3600.0
            recent_sleep = [
                float(row.sleep_total_s) / 3600.0
                for row in all_health
                if row.sleep_total_s is not None and day - timedelta(days=7) <= row.date < day
            ]
            if sleep_h < 6.0:
                red += 1
                reasons.append("sleep_debt")
            elif sleep_h < 6.5 or (recent_sleep and sum(recent_sleep) / len(recent_sleep) < 7.0):
                yellow += 1
                reasons.append("sleep_debt")

    for activity in day_activities:
        fb = feedback_by_label.get(activity.label_id)
        if fb is None or fb.rpe is None or fb.duration_minutes is None:
            continue
        if activity.training_dose is None:
            continue
        key = (activity.sport, activity.session_class)
        history = history_by_class.get(key, [])
        if len(history) < 6:
            continue
        subjective = float(fb.rpe) * float(fb.duration_minutes)
        subjective_history = [x for x, _ in history]
        dose_history = [x for _, x in history]
        z_subjective = _z(subjective, subjective_history)
        z_dose = _z(float(activity.training_dose), dose_history)
        diff = z_subjective - z_dose
        if diff >= 1.5 and z_subjective >= 1.0:
            red += 1
            reasons.append("srpe_dissociation")
        elif diff >= 1.0 and z_subjective >= 0.5:
            yellow += 1
            reasons.append("srpe_dissociation")

    if red or yellow >= 2:
        gate = "red"
    elif yellow:
        gate = "yellow"
    else:
        gate = "green"
    return gate, list(dict.fromkeys(reasons))


def compute_daily_load_series(
    activity_results: Sequence[ActivityLoadResult],
    health_rows: Sequence[HealthRow],
    hrv_rows: Sequence[HrvRow],
    feedback_rows: Sequence[FeedbackRow],
    start: date,
    end: date,
    prior_state: PriorLoadState | None = None,
) -> list[DailyLoadResult]:
    """Compute daily TSS-like dose plus fixed 7/42-day EWMA ATL/CTL."""
    by_date: dict[date, list[ActivityLoadResult]] = defaultdict(list)
    for activity in activity_results:
        by_date[activity.activity_date].append(activity)
    health_by_date = {row.date: row for row in health_rows}
    hrv_by_date = {row.date: row for row in hrv_rows}
    feedback_by_label = {row.label_id: row for row in feedback_rows}
    history_by_class: dict[tuple[str, SessionClass], list[tuple[float, float]]] = defaultdict(list)

    acute = prior_state.acute_load if prior_state else 0.0
    chronic = prior_state.chronic_load if prior_state else 0.0
    k_acute = 1.0 - math.exp(-1.0 / 7.0)
    k_chronic = 1.0 - math.exp(-1.0 / 42.0)
    out: list[DailyLoadResult] = []

    for day in _daterange(start, end):
        day_activities = by_date.get(day, [])
        if day_activities:
            usable = [
                activity
                for activity in day_activities
                if activity.training_dose is not None and not activity.excluded_from_pmc
            ]
            coverage_status = (
                LoadCoverageStatus.COMPLETE
                if len(usable) == len(day_activities)
                and all(activity.coverage_status == LoadCoverageStatus.COMPLETE for activity in usable)
                else LoadCoverageStatus.PARTIAL
                if usable
                else LoadCoverageStatus.UNKNOWN
            )
        elif day in health_by_date:
            # A provider health row proves the watch synced this calendar day;
            # with no activities it is an observed rest day, not missing data.
            coverage_status = LoadCoverageStatus.REST_CONFIRMED
        else:
            coverage_status = LoadCoverageStatus.UNKNOWN
        dose = sum(
            float(activity.training_dose)
            for activity in day_activities
            if activity.training_dose is not None and not activity.excluded_from_pmc
        )
        if coverage_status != LoadCoverageStatus.UNKNOWN:
            acute += k_acute * (dose - acute)
            chronic += k_chronic * (dose - chronic)
        gate, readiness_reasons = _readiness_for_day(
            day,
            health_by_date,
            hrv_by_date,
            health_rows,
            hrv_rows,
            day_activities,
            feedback_by_label,
            history_by_class,
        )
        ratio = acute / chronic if chronic > 0 else None
        calibration_id = next(
            (activity.calibration_id for activity in day_activities if activity.calibration_id is not None),
            None,
        )
        out.append(
            DailyLoadResult(
                date=day,
                calibration_id=calibration_id,
                training_dose=round(dose, 4),
                acute_load=round(acute, 4),
                chronic_load=round(chronic, 4),
                form=round(chronic - acute, 4),
                load_ratio=round(ratio, 4) if ratio is not None else None,
                coverage_status=coverage_status,
                readiness_gate=gate,
                readiness_reasons=readiness_reasons,
            )
        )
        for activity in day_activities:
            fb = feedback_by_label.get(activity.label_id)
            if fb is None or fb.rpe is None or fb.duration_minutes is None:
                continue
            if activity.training_dose is None:
                continue
            key = (activity.sport, activity.session_class)
            history_by_class[key].append((float(fb.rpe) * float(fb.duration_minutes), float(activity.training_dose)))
            if len(history_by_class[key]) > 90:
                history_by_class[key] = history_by_class[key][-90:]
    return out
