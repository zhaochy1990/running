"""Segment extraction helpers for running calibration."""

from __future__ import annotations

import math
from bisect import bisect_left
from dataclasses import dataclass
from statistics import mean, median
from typing import Iterable, Sequence

from .types import CalibrationConfidence, CalibrationEvidence, RunningActivity, RunningLap, RunningSample

THRESHOLD_SPEED_LOW_RATIO = 0.94
THRESHOLD_SPEED_HIGH_RATIO = 1.07
THRESHOLD_SPEED_MAX_CV = 0.07
SHORT_SPRINT_HR_CUTOFF_BPM = 198
LAP_STREAM_ACTIVITY_TOLERANCE = 1.1
# Half-life (days) for down-weighting older best-effort observations so
# calibration tracks recent fitness instead of being pinned by one old peak.
# Single source: both threshold estimation (`core`) and speed-duration model
# fitting (`prediction`) share this weighting so they cannot drift apart.
RECENCY_HALF_LIFE_DAYS = 90


@dataclass(frozen=True)
class SpeedCandidate:
    activity: RunningActivity
    duration_s: float
    avg_speed_mps: float
    source: str
    start_s: float | None = None
    end_s: float | None = None
    confidence: CalibrationConfidence = CalibrationConfidence.LOW


@dataclass(frozen=True)
class DistanceCandidate:
    """A continuous segment of an activity that covered a target distance.

    Times are in seconds relative to the activity's first timeseries point.
    `distance_m` is the canonical target distance (not the actual cumulative
    distance traveled in the segment, which equals the target by definition).
    """

    race_type: str
    distance_m: float
    duration_s: float
    start_s: float
    end_s: float


def best_distance_candidates(
    timeseries: Sequence[tuple[float, float]],
    pauses_s: Sequence[tuple[float, float]],
    canonical_distances: dict[str, float],
) -> dict[str, DistanceCandidate]:
    """For each race_type, find the fastest continuous segment of the given
    target distance whose [start, end] does NOT overlap any pause interval.

    Two-pointer sliding window on the cumulative-distance series.
    Linear interpolation gives sub-tick precision on segment endpoints.
    """
    if len(timeseries) < 2:
        return {}
    total_dist = timeseries[-1][1] - timeseries[0][1]
    out: dict[str, DistanceCandidate] = {}

    for race_type, target in canonical_distances.items():
        if total_dist < target:
            continue
        best: tuple[float, float, float] | None = None  # (duration, start_t, end_t)
        j = 0
        for i in range(len(timeseries)):
            t_i, d_i = timeseries[i]
            while j < len(timeseries) and timeseries[j][1] - d_i < target:
                j += 1
            if j == len(timeseries):
                break

            a_t, a_d = timeseries[j - 1]
            b_t, b_d = timeseries[j]
            if b_d == a_d:
                end_t = b_t
            else:
                end_t = a_t + (d_i + target - a_d) / (b_d - a_d) * (b_t - a_t)

            if _overlaps_any_pause(t_i, end_t, pauses_s):
                continue

            seg_dur = end_t - t_i
            if best is None or seg_dur < best[0]:
                best = (seg_dur, t_i, end_t)

        if best is not None:
            out[race_type] = DistanceCandidate(
                race_type=race_type,
                distance_m=target,
                duration_s=best[0],
                start_s=best[1],
                end_s=best[2],
            )
    return out


def _overlaps_any_pause(
    seg_start_s: float, seg_end_s: float, pauses_s: Sequence[tuple[float, float]]
) -> bool:
    """Half-open intersection: pause ending exactly at seg_start (or pause
    starting exactly at seg_end) is NOT an overlap — boundary pauses don't
    disqualify."""
    for ps, pe in pauses_s:
        if pe > seg_start_s and ps < seg_end_s:
            return True
    return False


@dataclass(frozen=True)
class ThresholdHrCandidate:
    activity: RunningActivity
    start_s: float
    end_s: float
    duration_s: float
    avg_speed_mps: float
    avg_hr: float
    confidence: CalibrationConfidence


@dataclass(frozen=True)
class _PreparedSamples:
    samples: tuple[RunningSample, ...]
    times: tuple[float, ...]
    distances: tuple[float | None, ...]
    speeds: tuple[float | None, ...]
    hrs: tuple[float | None, ...]
    distance_count: tuple[int, ...]
    speed_count: tuple[int, ...]
    speed_sum: tuple[float, ...]
    speed_sq_sum: tuple[float, ...]
    hr_count: tuple[int, ...]
    hr_sum: tuple[float, ...]


def is_running(activity: RunningActivity) -> bool:
    sport = (activity.sport or "").strip().lower()
    return sport == "run" or sport.startswith("run_") or sport.startswith("running")


def sample_time(sample: RunningSample, index: int) -> float:
    if sample.elapsed_s is not None:
        return float(sample.elapsed_s)
    if sample.timestamp_s is not None:
        return float(sample.timestamp_s)
    return float(index)


def sample_speed(sample: RunningSample) -> float | None:
    if sample.speed_mps is None:
        return None
    try:
        speed = float(sample.speed_mps)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(speed) or speed <= 0:
        return None
    if speed > 8.5:
        return None
    return speed


def clean_samples(samples: Sequence[RunningSample]) -> tuple[RunningSample, ...]:
    out: list[RunningSample] = []
    last_distance: float | None = None
    for i, sample in enumerate(samples):
        speed = sample_speed(sample)
        distance = sample.distance_m
        if distance is not None:
            try:
                distance = float(distance)
            except (TypeError, ValueError):
                distance = None
        if distance is not None and last_distance is not None:
            dt = sample_time(sample, i) - sample_time(samples[i - 1], i - 1)
            dd = distance - last_distance
            if dt <= 0 or dd < -5 or (dt > 0 and dd / dt > 8.5):
                distance = None
        if distance is not None:
            last_distance = distance
        out.append(
            RunningSample(
                timestamp_s=sample.timestamp_s,
                elapsed_s=sample.elapsed_s,
                distance_m=distance,
                heart_rate_bpm=sample.heart_rate_bpm,
                speed_mps=speed,
                power_w=sample.power_w,
                altitude_m=sample.altitude_m,
            )
        )
    return tuple(out)


def _prefix_add(prefix: list[float], value: float) -> None:
    prefix.append(prefix[-1] + value)


def _prefix_add_count(prefix: list[int], present: bool) -> None:
    prefix.append(prefix[-1] + (1 if present else 0))


def _prepare_samples(samples: Sequence[RunningSample]) -> _PreparedSamples:
    clean = clean_samples(samples)
    times: list[float] = []
    distances: list[float | None] = []
    speeds: list[float | None] = []
    hrs: list[float | None] = []
    distance_count = [0]
    speed_count = [0]
    speed_sum = [0.0]
    speed_sq_sum = [0.0]
    hr_count = [0]
    hr_sum = [0.0]
    for i, sample in enumerate(clean):
        times.append(sample_time(sample, i))
        distances.append(sample.distance_m)
        speed = sample.speed_mps if sample.speed_mps is not None and 1.5 <= float(sample.speed_mps) <= 8.5 else None
        speeds.append(float(speed) if speed is not None else None)
        hr = _hr_value(sample.heart_rate_bpm)
        hrs.append(hr)
        _prefix_add_count(distance_count, sample.distance_m is not None)
        _prefix_add_count(speed_count, speed is not None)
        _prefix_add(speed_sum, float(speed) if speed is not None else 0.0)
        _prefix_add(speed_sq_sum, float(speed) ** 2 if speed is not None else 0.0)
        _prefix_add_count(hr_count, hr is not None)
        _prefix_add(hr_sum, float(hr) if hr is not None else 0.0)
    return _PreparedSamples(
        samples=clean,
        times=tuple(times),
        distances=tuple(distances),
        speeds=tuple(speeds),
        hrs=tuple(hrs),
        distance_count=tuple(distance_count),
        speed_count=tuple(speed_count),
        speed_sum=tuple(speed_sum),
        speed_sq_sum=tuple(speed_sq_sum),
        hr_count=tuple(hr_count),
        hr_sum=tuple(hr_sum),
    )


def _range_count(prefix: Sequence[int], start: int, end: int) -> int:
    return prefix[end + 1] - prefix[start]


def _range_sum(prefix: Sequence[float], start: int, end: int) -> float:
    return prefix[end + 1] - prefix[start]


def _duration_from_samples(samples: Sequence[RunningSample]) -> float | None:
    if len(samples) < 2:
        return None
    start = sample_time(samples[0], 0)
    end = sample_time(samples[-1], len(samples) - 1)
    return end - start if end > start else None


def activity_duration_s(activity: RunningActivity) -> float | None:
    if activity.duration_s is not None and activity.duration_s > 0:
        return float(activity.duration_s)
    return _duration_from_samples(activity.samples)


def activity_mean_speed(activity: RunningActivity) -> float | None:
    duration = activity_duration_s(activity)
    if not duration or duration <= 0:
        return None
    if activity.distance_m is not None and activity.distance_m >= 500:
        speed = float(activity.distance_m) / duration
        if 1.5 <= speed <= 8.5:
            return speed
    speeds = [s for sample in activity.samples if (s := sample_speed(sample)) is not None]
    return mean(speeds) if speeds else None


def _window_average_speed_prepared(prepared: _PreparedSamples, start: int, end: int) -> float | None:
    size = end - start + 1
    if size <= 1:
        return None
    distance_count = _range_count(prepared.distance_count, start, end)
    first_distance = prepared.distances[start]
    last_distance = prepared.distances[end]
    if distance_count / size >= 0.8 and first_distance is not None and last_distance is not None:
        dt = prepared.times[end] - prepared.times[start]
        dd = float(last_distance) - float(first_distance)
        if dt > 0 and dd > 0:
            speed = dd / dt
            if 1.5 <= speed <= 8.5:
                return speed
    speed_count = _range_count(prepared.speed_count, start, end)
    if speed_count / size >= 0.8 and speed_count > 0:
        return _range_sum(prepared.speed_sum, start, end) / speed_count
    return None


def _best_speed_for_duration_prepared(
    activity: RunningActivity,
    duration_s: int,
    prepared: _PreparedSamples,
) -> SpeedCandidate | None:
    if len(prepared.samples) >= 2:
        best: tuple[float, int, int] | None = None
        for right in range(1, len(prepared.samples)):
            target = prepared.times[right] - duration_s
            left = bisect_left(prepared.times, target, 0, right)
            if left > 0 and abs(prepared.times[right] - prepared.times[left - 1] - duration_s) < abs(prepared.times[right] - prepared.times[left] - duration_s):
                left -= 1
            elapsed = prepared.times[right] - prepared.times[left]
            if abs(elapsed - duration_s) > 30:
                continue
            if duration_s >= 20 * 60 and not _stable_speed_window_prepared(prepared, left, right, max_cv=0.12):
                continue
            speed = _window_average_speed_prepared(prepared, left, right)
            if speed is not None and (best is None or speed > best[0]):
                best = (speed, left, right)
        if best is not None:
            speed, left, right = best
            return SpeedCandidate(
                activity=activity,
                duration_s=float(duration_s),
                avg_speed_mps=speed,
                source="timeseries",
                start_s=prepared.times[left],
                end_s=prepared.times[right],
                confidence=CalibrationConfidence.HIGH,
            )

    lap_best = _best_lap_block(activity, duration_s)
    if lap_best is not None:
        return lap_best

    duration = activity_duration_s(activity)
    speed = activity_mean_speed(activity)
    if duration is None or speed is None:
        return None
    if duration_s >= 20 * 60 and len(prepared.samples) >= 2:
        if not _stable_speed_window_prepared(prepared, 0, len(prepared.samples) - 1, max_cv=0.12):
            return None
    if duration >= duration_s * 0.9:
        return SpeedCandidate(
            activity=activity,
            duration_s=float(min(duration, duration_s)),
            avg_speed_mps=speed,
            source="activity",
            start_s=0.0,
            end_s=duration,
            confidence=CalibrationConfidence.MEDIUM if duration >= duration_s else CalibrationConfidence.LOW,
        )
    return None


def _best_lap_block(activity: RunningActivity, duration_s: int) -> SpeedCandidate | None:
    if not activity.laps:
        return None
    best_speed: float | None = None
    best_span: tuple[Sequence[RunningLap], int, int, float] | None = None
    for laps in _valid_lap_streams(activity):
        for left in range(len(laps)):
            total_duration = 0.0
            total_distance = 0.0
            for right in range(left, len(laps)):
                lap = laps[right]
                if not lap.duration_s or not lap.distance_m:
                    continue
                total_duration += float(lap.duration_s)
                total_distance += float(lap.distance_m)
                if total_duration < duration_s * 0.9:
                    continue
                if total_duration > duration_s * 1.2:
                    break
                speed = total_distance / total_duration if total_duration > 0 else None
                if speed is not None and 1.5 <= speed <= 8.5 and (best_speed is None or speed > best_speed):
                    best_speed = speed
                    best_span = (laps, left, right, total_duration)
    if best_speed is None or best_span is None:
        return None
    laps, left, _right, total_duration = best_span
    start_s = sum(float(l.duration_s or 0) for l in laps[:left])
    return SpeedCandidate(
        activity=activity,
        duration_s=total_duration,
        avg_speed_mps=best_speed,
        source="laps",
        start_s=start_s,
        end_s=start_s + total_duration,
        confidence=CalibrationConfidence.MEDIUM,
    )


def _valid_lap_streams(activity: RunningActivity) -> list[tuple[RunningLap, ...]]:
    by_type: dict[str, list[RunningLap]] = {}
    for lap in activity.laps:
        by_type.setdefault(str(lap.lap_type or "default"), []).append(lap)
    streams = [tuple(laps) for laps in by_type.values()]
    if len(streams) == 1:
        return streams if _lap_stream_matches_activity(activity, streams[0]) else []
    return [stream for stream in streams if _lap_stream_matches_activity(activity, stream)]


def _lap_stream_matches_activity(activity: RunningActivity, laps: Sequence[RunningLap]) -> bool:
    total_duration = 0.0
    total_distance = 0.0
    has_duration = False
    has_distance = False
    for lap in laps:
        if not lap.duration_s or not lap.distance_m:
            continue
        total_duration += float(lap.duration_s)
        total_distance += float(lap.distance_m)
        has_duration = True
        has_distance = True
    if not has_duration or not has_distance:
        return False
    # Why: providers may store overlapping lap streams (km, mile, workout
    # phases). Each stream must be plausible against the parent activity.
    if activity.duration_s and total_duration > float(activity.duration_s) * LAP_STREAM_ACTIVITY_TOLERANCE:
        return False
    if activity.distance_m and total_distance > float(activity.distance_m) * LAP_STREAM_ACTIVITY_TOLERANCE:
        return False
    return True


def best_speed_candidates(
    history: Sequence[RunningActivity], durations_s: Iterable[int],
) -> list[SpeedCandidate]:
    candidates: list[SpeedCandidate] = []
    for activity in history:
        if not is_running(activity):
            continue
        prepared = _prepare_samples(activity.samples)
        for duration_s in durations_s:
            candidate = _best_speed_for_duration_prepared(activity, duration_s, prepared)
            if candidate is not None:
                candidates.append(candidate)
    return candidates


def _hr_value(value: float | None) -> float | None:
    if value is None:
        return None
    hr = float(value)
    return hr if 80 <= hr <= 230 else None


def _coefficient_of_variation(values: Sequence[float]) -> float:
    if not values:
        return 999.0
    avg = mean(values)
    if avg <= 0:
        return 999.0
    return math.sqrt(sum((v - avg) ** 2 for v in values) / len(values)) / avg


def _stable_speed_window(
    samples: Sequence[RunningSample], start: int, end: int, *, max_cv: float,
) -> bool:
    window = samples[start : end + 1]
    speeds = [float(sample.speed_mps) for sample in window if sample.speed_mps is not None]
    if len(speeds) / len(window) < 0.8:
        return True
    return _coefficient_of_variation(speeds) <= max_cv


def _stable_speed_window_prepared(
    prepared: _PreparedSamples, start: int, end: int, *, max_cv: float,
) -> bool:
    size = end - start + 1
    if size <= 1:
        return False
    count = _range_count(prepared.speed_count, start, end)
    if count / size < 0.8:
        return True
    total = _range_sum(prepared.speed_sum, start, end)
    avg = total / count if count else 0.0
    if avg <= 0:
        return False
    sq_total = _range_sum(prepared.speed_sq_sum, start, end)
    variance = max(0.0, sq_total / count - avg * avg)
    return math.sqrt(variance) / avg <= max_cv


def stable_threshold_hr_candidates(
    history: Sequence[RunningActivity],
    threshold_speed_mps: float,
    *,
    min_duration_s: int = 20 * 60,
    max_duration_s: int = 40 * 60,
) -> list[ThresholdHrCandidate]:
    out: list[ThresholdHrCandidate] = []
    for activity in history:
        if not is_running(activity):
            continue
        prepared = _prepare_samples(activity.samples)
        if len(prepared.samples) >= 2:
            out.extend(_timeseries_threshold_hr_candidates(activity, prepared, threshold_speed_mps, min_duration_s, max_duration_s))
        if not any(c.activity.label_id == activity.label_id for c in out):
            fallback = _activity_threshold_hr_candidate(activity, threshold_speed_mps, min_duration_s, max_duration_s)
            if fallback is not None:
                out.append(fallback)
    return out


def _timeseries_threshold_hr_candidates(
    activity: RunningActivity,
    prepared: _PreparedSamples,
    threshold_speed_mps: float,
    min_duration_s: int,
    max_duration_s: int,
) -> list[ThresholdHrCandidate]:
    candidates: list[ThresholdHrCandidate] = []
    best_by_activity: ThresholdHrCandidate | None = None
    step = 5 * 60
    for duration_s in range(min_duration_s, max_duration_s + 1, step):
        for right in range(1, len(prepared.samples)):
            target = prepared.times[right] - duration_s
            left = bisect_left(prepared.times, target, 0, right)
            if left > 0 and abs(prepared.times[right] - prepared.times[left - 1] - duration_s) < abs(prepared.times[right] - prepared.times[left] - duration_s):
                left -= 1
            elapsed = prepared.times[right] - prepared.times[left]
            if abs(elapsed - duration_s) > 30:
                continue
            size = right - left + 1
            avg_speed = _window_average_speed_prepared(prepared, left, right)
            # Why: threshold-HR evidence should come from sustained work near,
            # not far below or far above, the estimated threshold speed.
            if avg_speed is None or not (
                THRESHOLD_SPEED_LOW_RATIO * threshold_speed_mps
                <= avg_speed
                <= THRESHOLD_SPEED_HIGH_RATIO * threshold_speed_mps
            ):
                continue
            speed_count = _range_count(prepared.speed_count, left, right)
            if speed_count / size < 0.8 or not _stable_speed_window_prepared(prepared, left, right, max_cv=THRESHOLD_SPEED_MAX_CV):
                continue
            hr_count = _range_count(prepared.hr_count, left, right)
            if hr_count / size < 0.8:
                continue
            max_hr = max((hr for hr in prepared.hrs[left : right + 1] if hr is not None), default=0.0)
            # Why: very high HR in sub-30-minute windows is more likely a short
            # race/sprint than a lactate-threshold segment.
            if max_hr >= SHORT_SPRINT_HR_CUTOFF_BPM and elapsed < 30 * 60:
                continue
            tail_start_time = prepared.times[right] - min(20 * 60, elapsed * 0.5)
            tail_start = bisect_left(prepared.times, tail_start_time, left, right + 1)
            tail_hr_count = _range_count(prepared.hr_count, tail_start, right)
            if tail_hr_count <= 0:
                continue
            tail_hr = _range_sum(prepared.hr_sum, tail_start, right) / tail_hr_count
            candidate = ThresholdHrCandidate(
                activity=activity,
                start_s=prepared.times[left],
                end_s=prepared.times[right],
                duration_s=elapsed,
                avg_speed_mps=avg_speed,
                avg_hr=tail_hr,
                confidence=CalibrationConfidence.HIGH,
            )
            if best_by_activity is None or _candidate_score(candidate, threshold_speed_mps) > _candidate_score(best_by_activity, threshold_speed_mps):
                best_by_activity = candidate
    if best_by_activity is not None:
        candidates.append(best_by_activity)
    return candidates


def _activity_threshold_hr_candidate(
    activity: RunningActivity,
    threshold_speed_mps: float,
    min_duration_s: int,
    max_duration_s: int,
) -> ThresholdHrCandidate | None:
    duration = activity_duration_s(activity)
    speed = activity_mean_speed(activity)
    hr = _hr_value(activity.avg_hr)
    if duration is None or speed is None or hr is None:
        return None
    if len(activity.samples) >= 2:
        samples = clean_samples(activity.samples)
        if not _stable_speed_window(samples, 0, len(samples) - 1, max_cv=0.12):
            return None
    if not (min_duration_s <= duration <= max_duration_s * 1.5):
        return None
    if not (0.94 * threshold_speed_mps <= speed <= 1.07 * threshold_speed_mps):
        return None
    return ThresholdHrCandidate(
        activity=activity,
        start_s=0.0,
        end_s=duration,
        duration_s=duration,
        avg_speed_mps=speed,
        avg_hr=hr,
        confidence=CalibrationConfidence.MEDIUM,
    )


def _candidate_score(candidate: ThresholdHrCandidate, threshold_speed_mps: float) -> float:
    duration_score = min(candidate.duration_s / (30 * 60), 1.2)
    speed_score = 1.0 - min(abs(candidate.avg_speed_mps - threshold_speed_mps) / threshold_speed_mps, 0.2)
    return duration_score + speed_score


def evidence_from_speed(candidate: SpeedCandidate, *, kind: str = "threshold_speed") -> CalibrationEvidence:
    return CalibrationEvidence(
        kind=kind,
        label_id=candidate.activity.label_id,
        activity_date=candidate.activity.activity_date,
        start_s=candidate.start_s,
        end_s=candidate.end_s,
        duration_s=candidate.duration_s,
        avg_speed_mps=candidate.avg_speed_mps,
        confidence=candidate.confidence,
        source={"method": candidate.source},
    )


def evidence_from_hr(candidate: ThresholdHrCandidate) -> CalibrationEvidence:
    return CalibrationEvidence(
        kind="threshold_hr",
        label_id=candidate.activity.label_id,
        activity_date=candidate.activity.activity_date,
        start_s=candidate.start_s,
        end_s=candidate.end_s,
        duration_s=candidate.duration_s,
        avg_speed_mps=candidate.avg_speed_mps,
        avg_hr=candidate.avg_hr,
        confidence=candidate.confidence,
        source={"method": "stable_segment_tail_hr"},
    )


def recency_weight(
    activity_date: date, as_of_date: date, *, half_life_days: float = RECENCY_HALF_LIFE_DAYS,
) -> float:
    """Exponential decay of an observation's weight by age (half-life in days)."""
    age_days = max(0, (as_of_date - activity_date).days)
    return 0.5 ** (age_days / half_life_days)


def candidate_weight(candidate: SpeedCandidate, as_of_date: date) -> float:
    """Shared calibration weight for a best-effort candidate.

    Combines duration trust (longer efforts weighted up), confidence, source
    quality, and recency decay. Both `core._threshold_speed_projections` and
    `prediction.fit_speed_duration_model` use this so the threshold estimate and
    the speed-duration curve are fit on the same evidence weighting.
    """
    weight = math.sqrt(max(candidate.duration_s, 1.0) / (60 * 60))
    if candidate.confidence == CalibrationConfidence.HIGH:
        weight *= 1.5
    elif candidate.confidence == CalibrationConfidence.LOW:
        weight *= 0.6
    if candidate.source == "timeseries":
        weight *= 1.15
    weight *= recency_weight(candidate.activity.activity_date, as_of_date)
    return weight


def weighted_median(values: Sequence[tuple[float, float]]) -> float | None:
    if not values:
        return None
    ordered = sorted((float(v), max(0.0, float(w))) for v, w in values)
    total = sum(w for _, w in ordered)
    if total <= 0:
        return median(v for v, _ in ordered)
    acc = 0.0
    for value, weight in ordered:
        acc += weight
        if acc >= total / 2.0:
            return value
    return ordered[-1][0]
