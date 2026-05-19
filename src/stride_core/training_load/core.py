"""Pure objective training-load algorithms."""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, timedelta
from statistics import median
from typing import Iterable, Sequence

from .types import (
    ActivityLoadInput,
    ActivityLoadResult,
    ActivitySample,
    CalibrationSnapshot,
    DailyLoadResult,
    FeedbackRow,
    HealthRow,
    HrvRow,
    LoadConfidence,
    PriorLoadState,
    SessionClass,
)

_RUNNING_SPORTS = {"run", "run_outdoor", "run_indoor", "run_trail", "run_track", "run_treadmill"}


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


def _sample_delta_minutes(samples: Sequence[ActivitySample], index: int) -> float:
    if index <= 0 or index >= len(samples):
        return 0.0
    delta = _sample_time(samples[index], index) - _sample_time(samples[index - 1], index - 1)
    if delta <= 0 or delta > 300:
        return 0.0
    return delta / 60.0


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
    return minutes * hrr * 0.64 * math.exp(1.92 * hrr)


def _compute_cardio_load(
    activity: ActivityLoadInput, calibration: CalibrationSnapshot
) -> tuple[float | None, float | None, list[str], LoadConfidence]:
    if not activity.samples:
        return None, None, ["heart_rate_missing"], LoadConfidence.NONE
    rhr = calibration.rhr_baseline
    hrmax = calibration.hrmax_estimate
    if rhr is None or hrmax is None or hrmax <= rhr:
        return None, None, ["hr_calibration_missing"], LoadConfidence.NONE

    clean_hr = _clean_hr_values(activity.samples)
    valid = [hr for hr in clean_hr if hr is not None]
    if not valid:
        return None, None, ["heart_rate_missing"], LoadConfidence.NONE

    raw = 0.0
    total_minutes = 0.0
    for i, hr in enumerate(clean_hr):
        minutes = _sample_delta_minutes(activity.samples, i)
        total_minutes += minutes
        if hr is None or minutes <= 0:
            continue
        hrr = _clamp((hr - rhr) / (hrmax - rhr), 0.0, 1.05)
        raw += _banister_trimp(hrr, minutes)

    duration_min = _duration_minutes(activity) or total_minutes
    coverage = total_minutes / duration_min if duration_min and duration_min > 0 else 0.0
    confidence = LoadConfidence.HIGH if coverage >= 0.7 else LoadConfidence.LOW
    reasons: list[str] = []
    if confidence == LoadConfidence.LOW:
        reasons.append("heart_rate_low_coverage")

    threshold_hr = calibration.threshold_hr
    if threshold_hr is None:
        reasons.append("threshold_hr_missing")
        return _round(raw), None, reasons, confidence

    threshold_hrr = (threshold_hr - rhr) / (hrmax - rhr)
    if threshold_hrr <= 0:
        reasons.append("threshold_hr_invalid")
        return _round(raw), None, reasons, confidence

    threshold_trimp_1h = _banister_trimp(_clamp(threshold_hrr, 0.0, 1.05), 60.0)
    if threshold_trimp_1h <= 0:
        reasons.append("threshold_hr_invalid")
        return _round(raw), None, reasons, confidence
    cardio_tss = 100.0 * raw / threshold_trimp_1h
    return _round(raw), _round(cardio_tss), reasons, confidence


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


def _rolling_mean(values: Sequence[float], window: int) -> list[float]:
    out: list[float] = []
    queue: list[float] = []
    total = 0.0
    for value in values:
        queue.append(value)
        total += value
        if len(queue) > window:
            total -= queue.pop(0)
        out.append(total / len(queue))
    return out


def _compute_external_tss(
    activity: ActivityLoadInput, calibration: CalibrationSnapshot
) -> tuple[float | None, list[str], LoadConfidence, float | None]:
    samples = activity.samples
    if not samples:
        return None, ["external_samples_missing"], LoadConfidence.NONE, None

    ifs: list[float] = []
    use_power = bool(calibration.critical_power_w and calibration.critical_power_w > 0)
    use_speed = bool(calibration.threshold_speed_mps and calibration.threshold_speed_mps > 0)
    reasons: list[str] = []

    if use_power:
        power = _series_values(samples, "power_w")
        if power and len(power) / len(samples) >= 0.8:
            for sample in samples:
                if sample.power_w is not None and sample.power_w > 0:
                    ifs.append(_clamp(float(sample.power_w) / float(calibration.critical_power_w), 0.3, 2.0))
        else:
            use_power = False

    if not ifs and use_speed:
        altitude_present = len(_series_values(samples, "altitude_m")) / len(samples) >= 0.8
        distance_present = len(_series_values(samples, "distance_m")) / len(samples) >= 0.8
        grade_ok = altitude_present and distance_present
        if not grade_ok:
            reasons.append("grade_unavailable_flat_speed")
        for i, sample in enumerate(samples):
            speed = sample.speed_mps
            if speed is None or speed <= 0:
                continue
            grade = _distance_window_grade(samples, i) if grade_ok else None
            adjusted = _grade_adjusted_speed(float(speed), grade)
            ifs.append(_clamp(adjusted / float(calibration.threshold_speed_mps), 0.3, 2.0))

    if not ifs:
        reasons.append("external_calibration_missing")
        return None, reasons, LoadConfidence.NONE, None

    duration_min = _duration_minutes(activity)
    if duration_min is None or duration_min <= 0:
        reasons.append("duration_missing")
        return None, reasons, LoadConfidence.NONE, None

    rolling = _rolling_mean(ifs, 30)
    normalized_if = (sum(v**4 for v in rolling) / len(rolling)) ** 0.25
    tss = (duration_min / 60.0) * normalized_if**2 * 100.0
    if normalized_if < 1.0:
        tss = max(0.0, tss - 0.0001)
    confidence = LoadConfidence.HIGH if len(ifs) / len(samples) >= 0.8 else LoadConfidence.LOW
    return _round(tss), reasons, confidence, _round(normalized_if)


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

    Raw TRIMP, duration-only estimates, strength volume, and sRPE are kept as
    side-channel signals in v1 unless they can be normalized to TSS-like scale.
    """
    duration_min = _duration_minutes(activity)
    subjective = None
    if activity.rpe is not None and duration_min is not None:
        subjective = float(activity.rpe) * duration_min

    cardio_raw, cardio_tss, cardio_reasons, cardio_conf = _compute_cardio_load(activity, calibration)
    external_tss, external_reasons, external_conf, normalized_if = _compute_external_tss(activity, calibration)
    mechanical = _compute_mechanical_load(activity, normalized_if)

    reasons = list(cardio_reasons)
    reasons.extend(r for r in external_reasons if r != "grade_unavailable_flat_speed")

    training_dose: float | None = None
    confidence = LoadConfidence.NONE
    if cardio_tss is not None and external_tss is not None and _is_running(activity.sport):
        if activity.session_class in {SessionClass.INTERVAL, SessionClass.RACE}:
            training_dose = 0.4 * cardio_tss + 0.6 * external_tss
        else:
            training_dose = 0.7 * cardio_tss + 0.3 * external_tss
        confidence = _confidence_from_parts(cardio_conf, external_conf)
    elif external_tss is not None:
        training_dose = external_tss
        confidence = LoadConfidence.MEDIUM if external_conf == LoadConfidence.HIGH else external_conf
    elif cardio_tss is not None:
        training_dose = cardio_tss
        confidence = cardio_conf

    if training_dose is None:
        reasons.append("no_tss_like_objective_load")

    compact_reasons = list(dict.fromkeys(reasons))
    return ActivityLoadResult(
        label_id=activity.label_id,
        activity_date=activity.activity_date,
        sport=activity.sport,
        session_class=activity.session_class,
        duration_minutes=_round(duration_min),
        algorithm_version=calibration.algorithm_version,
        calibration_id=calibration.id,
        cardio_load_raw=cardio_raw,
        cardio_tss=cardio_tss,
        external_tss=external_tss,
        mechanical_load=mechanical,
        subjective_internal_load=_round(subjective),
        training_dose=_round(training_dose),
        load_confidence=confidence,
        excluded_from_pmc=training_dose is None,
        reasons=compact_reasons,
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
        dose = sum(
            float(activity.training_dose)
            for activity in day_activities
            if activity.training_dose is not None and not activity.excluded_from_pmc
        )
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
