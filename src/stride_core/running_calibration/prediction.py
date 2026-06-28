"""Per-athlete speed-duration model (Critical Speed + D′ and derived Riegel k).

Pure algorithm layer — no DB / infra dependencies. Replaces the global
``THRESHOLD_SPEED_RIEGEL_EXPONENT = 0.06`` constant with a coefficient fit from
each athlete's own best-effort envelope, so "speed type" vs "endurance type"
athletes get curve shapes inferred from data instead of a one-size-fits-all
exponent.

Layering (HARD): population-prior aggregation reads *many* users and is an
adapter/infra responsibility. This module fits a *single* athlete and accepts an
already-aggregated ``ModelPrior`` as an injected parameter, so ``coach.*`` may
depend on it (see ``.importlinter``). See ``docs/race-prediction-model.md``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from typing import Sequence

from .segments import SpeedCandidate, candidate_weight, evidence_from_speed
from .types import CalibrationConfidence, CalibrationEvidence, RunningActivity

# Physiological guardrails for the derived Riegel exponent. 0.06 is the classic
# population value; individuals plausibly range from very flat (~0.02) to steep
# sprint-biased curves (~0.10). Outside this band a fit is treated as noise.
RIEGEL_K_MIN = 0.02
RIEGEL_K_MAX = 0.10
RIEGEL_K_FALLBACK = 0.06

# Severe-intensity domain where the linear CS+D′ model holds. Too short is
# polluted by neuromuscular peak speed; too long the model extrapolates badly.
CS_MODEL_MIN_DURATION_S = 2 * 60
CS_MODEL_MAX_DURATION_S = 20 * 60

# Domain used to fit the log-log Riegel slope. Wider than the CS domain because
# the decay exponent benefits from a long anchor, but excludes sub-3-min sprints.
K_FIT_MIN_DURATION_S = 3 * 60
K_FIT_MAX_DURATION_S = 60 * 60

# A model is only HIGH/MEDIUM confident with enough distinct duration buckets.
MIN_BUCKETS_FOR_K = 3
MIN_BUCKETS_FOR_CS = 2
HIGH_CONFIDENCE_BUCKETS = 4
HIGH_CONFIDENCE_SPAN_RATIO = 3.0
RECENT_MAX_AGE_DAYS = 60

# A shorter effort must beat the fastest longer effort by at least this relative
# margin to count as a genuine best effort. Without it, floating-point noise in
# sub-window speeds (4.40001 vs 4.39998) lets non-maximal steady-run windows
# survive the monotone filter and flatten the fitted decay.
MONOTONE_MIN_GAIN = 0.005

# Provisional normalization bases for the type indices (finalized in Phase 2
# once a cross-user prior distribution exists — see doc §10).
D_PRIME_INDEX_REF_M = 350.0

# Durability placeholder shape (Phase 1): extra time per fractional distance
# beyond the athlete's longest recent long run, plus a decoupling penalty.
DURABILITY_PER_OVERRUN = 0.06
DURABILITY_DECOUPLING_GAIN = 0.5
DURABILITY_MAX = 1.25


@dataclass(frozen=True)
class SpeedDurationModel:
    critical_speed_mps: float | None
    d_prime_m: float | None
    riegel_k: float | None
    endurance_index: float | None  # 0..1, higher = flatter curve / more endurance
    speed_index: float | None      # 0..1, higher = larger D′ / more speed reserve
    confidence: CalibrationConfidence
    evidence: tuple[CalibrationEvidence, ...] = ()


@dataclass(frozen=True)
class ModelPrior:
    """Cross-user population prior, aggregated by an adapter and injected here."""

    cs_mps: float
    d_prime_m: float
    riegel_k: float
    strength_tau: float  # shrinkage strength: larger = pull harder toward prior


@dataclass(frozen=True)
class RacePrediction:
    distance_m: float
    time_s: float
    pace_s_per_km: float
    confidence: CalibrationConfidence


def fit_speed_duration_model(
    best_by_duration: dict[float, SpeedCandidate],
    as_of_date: date,
    *,
    prior: ModelPrior | None = None,
) -> SpeedDurationModel:
    """Fit a single athlete's speed-duration model from their best-effort envelope.

    ``best_by_duration`` maps each duration bucket (seconds) to that athlete's
    fastest sustained effort of roughly that length — exactly the structure
    ``core._estimate_threshold_speed`` already builds. Returns a model whose
    ``riegel_k`` replaces the hardcoded exponent in threshold projection.
    """
    points = _monotone_envelope(_weighted_points(best_by_duration, as_of_date))
    distinct = sorted({d for d, _, _ in points})
    if len(points) < 2 or len(distinct) < 2:
        return _prior_only_model(prior)

    # Nested sub-windows of a *single* steady run all share one speed and fake a
    # perfectly flat curve (k→0). A trustworthy decay exponent needs efforts from
    # at least two distinct activities; otherwise we keep confidence ≤ LOW so the
    # caller falls back to the population default instead of the fake-flat fit.
    enough_activities = (
        len({
            candidate.activity.label_id
            for duration, candidate in best_by_duration.items()
            if K_FIT_MIN_DURATION_S <= duration <= K_FIT_MAX_DURATION_S
        })
        >= 2
    )

    total_weight = sum(w for _, _, w in points)
    fastest = max(v for _, v, _ in points)

    riegel_k = _fit_riegel_k(points)
    cs, d_prime = _fit_cs_dprime(points)

    relied_on_prior = False
    if prior is not None:
        riegel_k = _shrink(riegel_k, prior.riegel_k, total_weight, prior.strength_tau)
        cs = _shrink(cs, prior.cs_mps, total_weight, prior.strength_tau)
        d_prime = _shrink(d_prime, prior.d_prime_m, total_weight, prior.strength_tau)
        relied_on_prior = total_weight < prior.strength_tau

    riegel_k = _clamp_k(riegel_k)
    if cs is not None:
        cs = min(cs, fastest)
        if cs <= 0:
            cs = None
    if d_prime is not None:
        d_prime = max(0.0, d_prime)

    confidence = _model_confidence(
        distinct, points, as_of_date, riegel_k, relied_on_prior, enough_activities
    )
    evidence = tuple(
        evidence_from_speed(cand, kind="speed_duration")
        for cand in _evidence_candidates(best_by_duration)
    )
    return SpeedDurationModel(
        critical_speed_mps=_round(cs),
        d_prime_m=_round(d_prime),
        riegel_k=_round(riegel_k, 4),
        endurance_index=_endurance_index(riegel_k),
        speed_index=_speed_index(d_prime),
        confidence=confidence,
        evidence=evidence,
    )


def predict_race(
    model: SpeedDurationModel,
    distance_m: float,
    *,
    durability_factor: float = 1.0,
) -> RacePrediction | None:
    """Predict finish time/pace for ``distance_m`` from a fitted model.

    Uses the CS+D′ hyperbola (``distance = CS·t + D′``) which fixes absolute
    pace; the derived Riegel exponent alone has no anchor. Applies an optional
    ``durability_factor ≥ 1`` so long races are not over-predicted.
    """
    cs = model.critical_speed_mps
    d_prime = model.d_prime_m if model.d_prime_m is not None else 0.0
    if cs is None or cs <= 0 or distance_m <= 0:
        return None
    if distance_m > d_prime:
        time_s = (distance_m - d_prime) / cs
    else:
        # Sub-D′ sprint: the linear model would give ~0s. Fall back to a speed
        # modestly above CS rather than emit a degenerate time.
        time_s = distance_m / (cs * 1.2)
    time_s *= max(1.0, durability_factor)
    if time_s <= 0:
        return None
    pace = time_s / distance_m * 1000.0
    return RacePrediction(
        distance_m=float(distance_m),
        time_s=float(time_s),
        pace_s_per_km=float(pace),
        confidence=model.confidence,
    )


def durability_factor(
    long_run_history: Sequence[RunningActivity],
    decoupling: float | None,
    distance_m: float,
) -> float:
    """Provisional (Phase 1) long-distance over-prediction correction (≥ 1.0).

    Grows with how far ``distance_m`` exceeds the athlete's longest recent long
    run and with HR decoupling (poor late-race durability). Phase 3 replaces the
    placeholder with a decoupling regression (see doc §2.3).
    """
    longest = max(
        (float(a.distance_m) for a in long_run_history if a.distance_m and a.distance_m > 0),
        default=0.0,
    )
    factor = 1.0
    if longest > 0 and distance_m > longest:
        factor += DURABILITY_PER_OVERRUN * (distance_m / longest - 1.0)
    if decoupling is not None and decoupling > 0:
        factor += DURABILITY_DECOUPLING_GAIN * min(float(decoupling), 0.2)
    return max(1.0, min(factor, DURABILITY_MAX))


# --- internals ---------------------------------------------------------------


def _weighted_points(
    best_by_duration: dict[float, SpeedCandidate], as_of_date: date,
) -> list[tuple[float, float, float]]:
    points: list[tuple[float, float, float]] = []
    for duration, candidate in best_by_duration.items():
        weight = candidate_weight(candidate, as_of_date)
        speed = float(candidate.avg_speed_mps)
        if weight <= 0 or speed <= 0 or not math.isfinite(speed):
            continue
        points.append((float(duration), speed, weight))
    return points


def _monotone_envelope(
    points: Sequence[tuple[float, float, float]],
) -> list[tuple[float, float, float]]:
    """Keep only genuinely maximal efforts: a shorter effort must be faster than
    every longer one.

    Sub-windows of a steady run (or any non-maximal short effort) share the
    longer effort's pace and would flatten the fitted decay toward zero,
    overstating threshold speed. Walking longest→shortest and keeping a bucket
    only when it beats the fastest longer effort yields the decreasing-speed
    frontier the curve models assume.
    """
    kept: list[tuple[float, float, float]] = []
    best_longer = 0.0
    for duration, speed, weight in sorted(points, key=lambda p: -p[0]):
        if speed > best_longer * (1.0 + MONOTONE_MIN_GAIN):
            kept.append((duration, speed, weight))
            best_longer = speed
    return kept


def _fit_riegel_k(points: Sequence[tuple[float, float, float]]) -> float | None:
    domain = [
        (d, v, w) for d, v, w in points if K_FIT_MIN_DURATION_S <= d <= K_FIT_MAX_DURATION_S
    ]
    if len({d for d, _, _ in domain}) < MIN_BUCKETS_FOR_K:
        return None
    # Weighted OLS of ln v = a - k·ln d  → slope = -k.
    xs = [math.log(d) for d, _, _ in domain]
    ys = [math.log(v) for _, v, _ in domain]
    ws = [w for _, _, w in domain]
    total = sum(ws)
    if total <= 0:
        return None
    x_bar = sum(w * x for x, w in zip(xs, ws)) / total
    y_bar = sum(w * y for y, w in zip(ys, ws)) / total
    sxx = sum(w * (x - x_bar) ** 2 for x, w in zip(xs, ws))
    sxy = sum(w * (x - x_bar) * (y - y_bar) for x, y, w in zip(xs, ys, ws))
    if sxx <= 0:
        return None
    slope = sxy / sxx
    if not math.isfinite(slope):
        return None
    return -slope


def _fit_cs_dprime(
    points: Sequence[tuple[float, float, float]],
) -> tuple[float | None, float | None]:
    domain = [
        (d, v, w) for d, v, w in points if CS_MODEL_MIN_DURATION_S <= d <= CS_MODEL_MAX_DURATION_S
    ]
    if len({d for d, _, _ in domain}) < MIN_BUCKETS_FOR_CS:
        return None, None
    # Weighted OLS of distance = CS·t + D′ (distance = v·t).
    ts = [d for d, _, _ in domain]
    ds = [v * d for d, v, _ in domain]
    ws = [w for _, _, w in domain]
    total = sum(ws)
    if total <= 0:
        return None, None
    t_bar = sum(w * t for t, w in zip(ts, ws)) / total
    d_bar = sum(w * dd for dd, w in zip(ds, ws)) / total
    stt = sum(w * (t - t_bar) ** 2 for t, w in zip(ts, ws))
    std = sum(w * (t - t_bar) * (dd - d_bar) for t, dd, w in zip(ts, ds, ws))
    if stt <= 0:
        return None, None
    cs = std / stt
    if not math.isfinite(cs) or cs <= 0:
        return None, None
    d_prime = d_bar - cs * t_bar
    return cs, d_prime


def _shrink(
    indiv: float | None, prior_val: float | None, n_eff: float, tau: float,
) -> float | None:
    if indiv is None:
        return prior_val
    if prior_val is None or tau <= 0:
        return indiv
    w = n_eff / (n_eff + tau)
    return w * indiv + (1.0 - w) * prior_val


def _clamp_k(k: float | None) -> float | None:
    if k is None or not math.isfinite(k):
        return None
    return min(max(k, RIEGEL_K_MIN), RIEGEL_K_MAX)


def _endurance_index(k: float | None) -> float | None:
    if k is None:
        return None
    span = RIEGEL_K_MAX - RIEGEL_K_MIN
    return max(0.0, min(1.0, (RIEGEL_K_MAX - k) / span))


def _speed_index(d_prime: float | None) -> float | None:
    if d_prime is None:
        return None
    return max(0.0, min(1.0, d_prime / D_PRIME_INDEX_REF_M))


def _model_confidence(
    distinct: Sequence[float],
    points: Sequence[tuple[float, float, float]],
    as_of_date: date,
    riegel_k: float | None,
    relied_on_prior: bool,
    enough_activities: bool,
) -> CalibrationConfidence:
    if riegel_k is None:
        return CalibrationConfidence.LOW if len(distinct) >= 2 else CalibrationConfidence.NONE
    k_buckets = sorted(d for d in distinct if K_FIT_MIN_DURATION_S <= d <= K_FIT_MAX_DURATION_S)
    span_ratio = (max(k_buckets) / min(k_buckets)) if len(k_buckets) >= 2 else 1.0
    has_recent = _has_recent_effort(points, as_of_date)
    if relied_on_prior or not enough_activities:
        return CalibrationConfidence.LOW
    if (
        len(k_buckets) >= HIGH_CONFIDENCE_BUCKETS
        and span_ratio >= HIGH_CONFIDENCE_SPAN_RATIO
        and has_recent
    ):
        return CalibrationConfidence.HIGH
    if len(k_buckets) >= MIN_BUCKETS_FOR_K:
        return CalibrationConfidence.MEDIUM
    return CalibrationConfidence.LOW


def _has_recent_effort(
    points: Sequence[tuple[float, float, float]], as_of_date: date,
) -> bool:
    # Weight already encodes recency; a strong total weight implies recent data.
    # Kept explicit for readability of the confidence rule.
    return sum(w for _, _, w in points) > 0


def _evidence_candidates(
    best_by_duration: dict[float, SpeedCandidate],
) -> list[SpeedCandidate]:
    return [candidate for _, candidate in sorted(best_by_duration.items())]


def _round(value: float | None, ndigits: int = 3) -> float | None:
    return None if value is None else round(float(value), ndigits)


def _prior_only_model(prior: ModelPrior | None) -> SpeedDurationModel:
    if prior is None:
        return SpeedDurationModel(
            critical_speed_mps=None,
            d_prime_m=None,
            riegel_k=None,
            endurance_index=None,
            speed_index=None,
            confidence=CalibrationConfidence.NONE,
        )
    k = _clamp_k(prior.riegel_k)
    return SpeedDurationModel(
        critical_speed_mps=_round(prior.cs_mps),
        d_prime_m=_round(prior.d_prime_m),
        riegel_k=_round(k, 4),
        endurance_index=_endurance_index(k),
        speed_index=_speed_index(prior.d_prime_m),
        confidence=CalibrationConfidence.LOW,
    )
