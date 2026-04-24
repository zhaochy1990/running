"""Custom running ability score — pure algorithm module.

Implements the 4-layer ability model from `.omc/plans/custom-running-ability-score.md`:
  L1 — per-activity quality score (0-100)
  L2 — daily freshness/readiness score (0-100)
  L3 — 6-dimension rolling ability scores (evidence-driven)
  L4 — composite + marathon-time estimate

All functions here are pure (no DB access) except `compute_ability_snapshot`,
which is the sole orchestrator that reads from `db._conn`.
"""

from __future__ import annotations

import json
import math
import sqlite3
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence


# ---------------------------------------------------------------------------
# Calibration constants — central to L3 normalization.
# Each anchor pins a physical pace / metric to a target 0-100 score point so
# cross-week numbers remain comparable.  Tuned for sub-2:50 marathon target.
# ---------------------------------------------------------------------------

# Reference VDOT for VO2max dimension scoring.
# Anchor: 3:00:00 marathon (≈ VDOT 62 per Daniels) → score 60.
#   score = SCORE_AT_REF + (VDOT - REFERENCE_VDOT) * POINTS_PER_VDOT
# Implied scale: 2:50 target (VDOT 66) → 68; 2:43 (VDOT 72) → 80; 2:27 WR (VDOT 82) → 100.
VO2MAX_REFERENCE_VDOT = 62.0
VO2MAX_SCORE_AT_REF = 60.0
VO2MAX_POINTS_PER_VDOT = 2.0

# Aerobic anchor: pace at HR 145 bpm (steady Z2).
AEROBIC_ANCHOR_PACE_S_KM = 300.0  # 5:00/km → score 80
AEROBIC_POINTS_PER_SEC = 0.4       # 1 s/km faster → +0.4 points

# Lactate threshold anchor: best sustained 30-min pace.
LT_ANCHOR_PACE_S_KM = 250.0       # 4:10/km → score 80
LT_POINTS_PER_SEC = 0.5

# Endurance anchor: 4-week longest run.
ENDURANCE_ANCHOR_KM = 42  # full marathon = score 80 (base "very good"); ultra ≥52K pushes toward 100.0        # 32 km longest run → score 80
ENDURANCE_POINTS_PER_KM = 2.0     # ±1 km longest → ±2 points
ENDURANCE_DRIFT_PENALTY = 10.0    # HR drift >8% across long run: −10 points

# Economy anchor: cadence at 4:50/km.
ECONOMY_ANCHOR_CADENCE = 180
ECONOMY_POINTS_PER_SPM = 1.0

# Evidence-run thresholds.
EASY_HR_LOW_FACTOR = 0.65         # Easy: 65% HRmax
EASY_HR_HIGH_FACTOR = 0.85
LT_MIN_DURATION_S = 30 * 60       # 30 min sustained (Daniels T pace ≈ 1-hour race pace)
VO2MAX_INTERVAL_MIN_REPS = 3
VO2MAX_INTERVAL_MIN_DIST_M = 900.0  # ≥1K reps (allow 900m slack for GPS drift)
ENDURANCE_MIN_DISTANCE_KM = 25.0
AEROBIC_TARGET_HR = 145
AEROBIC_HR_TOLERANCE = 7  # [138, 152] — covers Karvonen Z2 for typical marathon runners
AEROBIC_MIN_DISTANCE_KM = 5.0
AEROBIC_MAX_HR_DRIFT = 0.08

# Ability is a slow-moving "what have you demonstrated you can do in a training cycle" metric.
# Window covers 1 full periodized training year so peak-block efforts stay counted even during
# base/taper blocks. Evidence age is exposed separately so UI can flag stale dimensions.
ABILITY_LOOKBACK_DAYS = 365

# Race-day performance is systematically better than training observations — taper reduces
# fatigue, race-day arousal adds 1-2%, and consistent pacing adds 1-2%. Published literature
# on the training→race gap ranges from 2-5%. We expose three points so UI can show a range
# without forcing a single point estimate:
#   - training_s: pure training extrapolation, no boost
#   - race_s:    typical well-executed race day (−3%, default headline number)
#   - best_case_s: optimally tapered + perfect execution (−5%, stretch ceiling)
RACE_DAY_BOOST_PCT = 0.03
BEST_CASE_BOOST_PCT = 0.05

# L4 composite weights (sub-2:50 emphasis on LT + endurance).
L4_WEIGHTS: dict[str, float] = {
    "aerobic": 0.20,
    "lt": 0.25,
    "vo2max": 0.20,
    "endurance": 0.20,
    "economy": 0.10,
    "recovery": 0.05,
}

# L1 sub-weights.
L1_WEIGHTS: dict[str, float] = {
    "pace_adherence": 0.30,
    "hr_zone_adherence": 0.25,
    "pace_stability": 0.20,
    "hr_decoupling": 0.15,
    "cadence_stability": 0.10,
}

# L2 sub-weights.
L2_WEIGHTS: dict[str, float] = {
    "tsb_score": 0.30,
    "rhr_score": 0.25,
    "hrv_score": 0.20,
    "fatigue_score": 0.25,
}

# train_type → target HR zone (as fraction of HRmax) when no plan target given.
TRAIN_TYPE_HR_TARGETS: dict[str, tuple[float, float]] = {
    "Base": (0.65, 0.78),
    "Aerobic Endurance": (0.65, 0.78),
    "Threshold": (0.82, 0.89),
    "Interval": (0.87, 0.95),
    "VO2 Max": (0.90, 0.98),
    "Anaerobic": (0.92, 1.00),
    "Sprint": (0.92, 1.00),
    "Recovery": (0.55, 0.70),
}


# ---------------------------------------------------------------------------
# Daniels VDOT — canonical table & formulas.
# ---------------------------------------------------------------------------

# VDOT → predicted marathon time (seconds).  Canonical Jack Daniels values,
# 30-85 in 5-point increments.  Intermediate VDOT uses linear interpolation.
DANIELS_VDOT_TO_MARATHON_S: dict[int, int] = {
    30: 5 * 3600 + 10 * 60 + 40,   # 5:10:40
    35: 4 * 3600 + 34 * 60 + 59,   # 4:34:59
    40: 4 * 3600 + 9 * 60 + 28,    # 4:09:28
    45: 3 * 3600 + 49 * 60 + 45,   # 3:49:45
    50: 3 * 3600 + 32 * 60 + 26,   # 3:32:26
    55: 3 * 3600 + 18 * 60 + 1,    # 3:18:01
    60: 3 * 3600 + 5 * 60 + 54,    # 3:05:54
    65: 2 * 3600 + 55 * 60 + 29,   # 2:55:29
    70: 2 * 3600 + 46 * 60 + 29,   # 2:46:29
    75: 2 * 3600 + 38 * 60 + 28,   # 2:38:28
    80: 2 * 3600 + 31 * 60 + 14,   # 2:31:14
    85: 2 * 3600 + 24 * 60 + 52,   # 2:24:52
}


def daniels_vo2_required(distance_m: float, time_s: float) -> float:
    """Daniels running VO2 cost: VO2 for running `distance_m` in `time_s`.

    Formula (Daniels & Gilbert, 1979):
        VO2 = -4.60 + 0.1823·v + 0.000104·v²  (ml/kg/min, v in m/min)
    """
    if distance_m <= 0 or time_s <= 0:
        return 0.0
    v = distance_m / (time_s / 60.0)  # m/min
    return -4.60 + 0.1823 * v + 0.000104 * (v ** 2)


def daniels_pct_vo2max(time_s: float) -> float:
    """Fraction of VO2max sustainable for a race of duration `time_s`.

    Formula:
        %VO2max = 0.8 + 0.1894393·exp(-0.012778·T) + 0.2989558·exp(-0.1932605·T)
    with T in minutes.
    """
    if time_s <= 0:
        return 1.0
    t_min = time_s / 60.0
    return (
        0.8
        + 0.1894393 * math.exp(-0.012778 * t_min)
        + 0.2989558 * math.exp(-0.1932605 * t_min)
    )


def daniels_vdot(distance_m: float, time_s: float) -> float:
    """Compute VDOT (ml/kg/min) from a race/best-effort distance+time.

    Returns 0.0 for degenerate inputs.
    """
    if distance_m <= 0 or time_s <= 0:
        return 0.0
    vo2_req = daniels_vo2_required(distance_m, time_s)
    pct = daniels_pct_vo2max(time_s)
    if pct <= 0:
        return 0.0
    return vo2_req / pct


def acsm_running_vo2(pace_s_km: float) -> float:
    """ACSM horizontal running VO2 (ml/kg/min) at the given pace.

    Formula: VO2 = 0.2 * v_m_min + 3.5  (valid for running, v in m/min)
    """
    if pace_s_km <= 0:
        return 0.0
    v_m_min = (1000.0 / pace_s_km) * 60.0
    return 0.2 * v_m_min + 3.5


def uth_sorensen_vo2max(hr_max: float, hr_rest: float) -> float:
    """Uth–Sørensen: VO2max ≈ 15.3 * HRmax / HRrest."""
    if hr_rest is None or hr_rest <= 0 or hr_max is None or hr_max <= 0:
        return 0.0
    return 15.3 * hr_max / hr_rest


def vdot_to_marathon_s(vdot: float) -> float | None:
    """Linear interpolation over the canonical Daniels table.

    Returns None for VDOT outside [30, 85].
    """
    if vdot is None or vdot <= 0:
        return None
    if vdot < 30 or vdot > 85:
        return None
    lo = int(vdot // 5) * 5
    hi = lo + 5
    if lo < 30:
        lo, hi = 30, 35
    if hi > 85:
        lo, hi = 80, 85
    lo_s = DANIELS_VDOT_TO_MARATHON_S[lo]
    hi_s = DANIELS_VDOT_TO_MARATHON_S[hi]
    frac = (vdot - lo) / (hi - lo) if hi != lo else 0.0
    return lo_s + frac * (hi_s - lo_s)


# ---------------------------------------------------------------------------
# Small helpers — numeric / statistics (pure, stdlib).
# ---------------------------------------------------------------------------

def _mean(xs: Iterable[float]) -> float:
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else 0.0


def _median(xs: Iterable[float]) -> float:
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return 0.0
    n = len(xs)
    m = n // 2
    if n % 2:
        return xs[m]
    return (xs[m - 1] + xs[m]) / 2.0


def _stdev(xs: Iterable[float]) -> float:
    xs = [x for x in xs if x is not None]
    if len(xs) < 2:
        return 0.0
    mu = sum(xs) / len(xs)
    var = sum((x - mu) ** 2 for x in xs) / (len(xs) - 1)
    return math.sqrt(var)


def _cv(xs: Iterable[float]) -> float:
    """Coefficient of variation; 0 when mean is 0 or too few samples."""
    xs = [x for x in xs if x is not None]
    if len(xs) < 2:
        return 0.0
    mu = sum(xs) / len(xs)
    if mu == 0:
        return 0.0
    return _stdev(xs) / abs(mu)


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _linreg(points: Sequence[tuple[float, float]]) -> tuple[float, float] | None:
    """Simple ordinary-least-squares regression.

    Returns (slope, intercept) or None if fewer than 2 distinct x values.
    """
    pts = [(x, y) for x, y in points if x is not None and y is not None]
    if len(pts) < 2:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    mx = sum(xs) / len(xs)
    my = sum(ys) / len(ys)
    num = sum((x - mx) * (y - my) for x, y in pts)
    den = sum((x - mx) ** 2 for x in xs)
    if den == 0:
        return None
    slope = num / den
    intercept = my - slope * mx
    return slope, intercept


# ---------------------------------------------------------------------------
# L1 — per-activity quality.
# ---------------------------------------------------------------------------

def _infer_target_hr_range(train_type: str | None, hr_max: int) -> tuple[int, int]:
    """Fallback HR target zone when no plan is supplied."""
    key = train_type or "Base"
    lo_frac, hi_frac = TRAIN_TYPE_HR_TARGETS.get(key, (0.65, 0.78))
    return int(round(hr_max * lo_frac)), int(round(hr_max * hi_frac))


def _laps_excluding_ends(laps: Sequence[Any]) -> list[Any]:
    """Drop laps that look like warmup/cooldown based on `exercise_type`.

    exercise_type 1 = warmup, 3 = cooldown, 4 = recovery.
    """
    out = []
    for lp in laps:
        ex = _get(lp, "exercise_type")
        if ex in (1, 3, 4):
            continue
        out.append(lp)
    # If everything was filtered away, return all but the literal first/last to
    # retain something useful.
    if not out and len(laps) >= 3:
        return list(laps[1:-1])
    if not out:
        return list(laps)
    return out


def _get(obj: Any, key: str, default: Any = None) -> Any:
    """Uniform accessor — supports dicts, sqlite Rows, and dataclasses."""
    if obj is None:
        return default
    if isinstance(obj, Mapping):
        return obj.get(key, default)
    # sqlite3.Row supports __getitem__ by column name but not .get
    try:
        if isinstance(obj, sqlite3.Row):
            if key in obj.keys():
                return obj[key]
            return default
    except Exception:
        pass
    return getattr(obj, key, default)


def compute_l1_quality(
    activity: Any,
    plan_target: dict | None = None,
    hr_max: int = 185,
) -> dict:
    """Compute L1 quality score (0-100) + 5 sub-scores for one activity.

    `activity` may be an `ActivityDetail` dataclass, a dict, or an sqlite3.Row.
    It should expose: train_type, avg_hr, max_hr, avg_pace_s_km, laps[],
    zones[], timeseries[].
    `plan_target` may provide:
        { "pace_s_km": float, "hr_lo": int, "hr_hi": int }
    Returns dict: {total, breakdown: {...}, evidence: []}
    """
    if activity is None:
        return {"total": 0.0, "breakdown": _empty_l1_breakdown(), "evidence": []}

    train_type = _get(activity, "train_type")
    avg_hr = _get(activity, "avg_hr")
    avg_pace = _get(activity, "avg_pace_s_km")
    laps = _get(activity, "laps") or []
    zones = _get(activity, "zones") or []
    ts = _get(activity, "timeseries") or []

    # Resolve target HR zone.
    if plan_target and plan_target.get("hr_lo") and plan_target.get("hr_hi"):
        hr_lo, hr_hi = int(plan_target["hr_lo"]), int(plan_target["hr_hi"])
    else:
        hr_lo, hr_hi = _infer_target_hr_range(train_type, hr_max)

    # Sub-score 1: pace_adherence.
    pace_adherence = _compute_pace_adherence(avg_pace, avg_hr, plan_target, hr_max)

    # Sub-score 2: hr_zone_adherence.
    hr_zone_adherence = _compute_hr_zone_adherence(ts, zones, hr_lo, hr_hi)

    # Sub-score 3: pace_stability (across main body of the run).
    core_laps = _laps_excluding_ends(laps)
    lap_paces = [_get(lp, "avg_pace") for lp in core_laps]
    pace_cv = _cv(lap_paces)
    pace_stability = _clamp(100.0 * (1.0 - pace_cv * 2.0), 0.0, 100.0)

    # Sub-score 4: hr_decoupling — second-half (HR/pace) vs first-half.
    hr_decoupling_raw = _compute_hr_decoupling(ts, laps)
    hr_decoupling_score = _clamp(100.0 - abs(hr_decoupling_raw) * 500.0, 0.0, 100.0)

    # Sub-score 5: cadence_stability.
    lap_cadences = [_get(lp, "avg_cadence") for lp in core_laps]
    cad_cv = _cv(lap_cadences)
    cadence_stability = _clamp(100.0 * (1.0 - cad_cv * 4.0), 0.0, 100.0)

    breakdown = {
        "pace_adherence": round(pace_adherence, 2),
        "hr_zone_adherence": round(hr_zone_adherence, 2),
        "pace_stability": round(pace_stability, 2),
        "hr_decoupling": round(hr_decoupling_score, 2),
        "cadence_stability": round(cadence_stability, 2),
        "hr_decoupling_raw": round(hr_decoupling_raw, 4),
        "target_hr_range": [hr_lo, hr_hi],
    }
    total = sum(breakdown[k] * w for k, w in L1_WEIGHTS.items())
    return {
        "total": round(total, 2),
        "breakdown": breakdown,
        "evidence": [_get(activity, "label_id")],
    }


def _empty_l1_breakdown() -> dict:
    return {k: 0.0 for k in L1_WEIGHTS}


def _compute_pace_adherence(
    avg_pace: float | None,
    avg_hr: int | None,
    plan_target: dict | None,
    hr_max: int,
) -> float:
    """Return 0-100 closeness of avg pace to target."""
    if avg_pace is None:
        return 0.0
    target_pace: float | None = None
    if plan_target and plan_target.get("pace_s_km"):
        target_pace = float(plan_target["pace_s_km"])
    elif avg_hr and hr_max:
        # Rough HR→pace map (seconds/km) using a linear proxy:
        # @65%HRmax → 6:10/km, @90%HRmax → 3:50/km.
        frac = _clamp(avg_hr / hr_max, 0.5, 1.05)
        target_pace = 370.0 - (frac - 0.65) / (0.90 - 0.65) * (370.0 - 230.0)
    if not target_pace or target_pace <= 0:
        return 60.0  # neutral when we cannot estimate
    err_frac = abs(avg_pace - target_pace) / target_pace
    return _clamp(100.0 - err_frac * 300.0, 0.0, 100.0)


def _compute_hr_zone_adherence(
    ts: Sequence[Any],
    zones: Sequence[Any],
    hr_lo: int,
    hr_hi: int,
) -> float:
    """% of run time with HR in [hr_lo, hr_hi]."""
    hrs = [
        _get(p, "heart_rate") for p in ts
        if _get(p, "heart_rate") is not None
    ]
    if hrs:
        in_range = sum(1 for h in hrs if hr_lo <= h <= hr_hi)
        pct = 100.0 * in_range / len(hrs)
        return pct
    # Fallback to HR zones table if timeseries empty.
    total_s = 0.0
    in_s = 0.0
    for z in zones:
        if _get(z, "zone_type") != "heartRate":
            continue
        rmin = _get(z, "range_min") or 0
        rmax = _get(z, "range_max") or 0
        dur = _get(z, "duration_s") or 0
        total_s += dur
        if rmin >= hr_lo and rmax <= hr_hi:
            in_s += dur
        elif rmax < hr_lo or rmin > hr_hi:
            continue
        else:
            # partial overlap — credit half
            in_s += dur * 0.5
    if total_s <= 0:
        return 0.0
    return 100.0 * in_s / total_s


def _compute_hr_decoupling(ts: Sequence[Any], laps: Sequence[Any]) -> float:
    """Raw decoupling fraction: (hr/pace second half)/(hr/pace first half) − 1.

    Positive = cardiac drift, negative = getting more efficient.
    """
    # Prefer timeseries (minute-level); fall back to laps.
    samples: list[tuple[int, float]] = []
    for p in ts:
        hr = _get(p, "heart_rate")
        sp = _get(p, "speed")
        if hr and sp and sp > 0:
            samples.append((hr, sp))
    if len(samples) < 20:
        # Fall back to laps: pace is seconds/km; speed = 1000/pace m/min ~ 1/pace s/m.
        samples = []
        for lp in laps:
            hr = _get(lp, "avg_hr")
            pace = _get(lp, "avg_pace")
            if hr and pace and pace > 0:
                speed_proxy = 1.0 / pace  # 1/ (s per km) — monotone in speed
                samples.append((hr, speed_proxy))
    if len(samples) < 4:
        return 0.0
    half = len(samples) // 2
    first = samples[:half]
    second = samples[half:]
    def ratio(pairs: list[tuple[int, float]]) -> float:
        hrs = [h for h, _ in pairs]
        sps = [s for _, s in pairs]
        mean_hr = _mean(hrs)
        mean_sp = _mean(sps)
        if mean_sp <= 0:
            return 0.0
        return mean_hr / mean_sp
    r1 = ratio(first)
    r2 = ratio(second)
    if r1 <= 0:
        return 0.0
    return (r2 - r1) / r1


# ---------------------------------------------------------------------------
# L2 — daily freshness / readiness.
# ---------------------------------------------------------------------------

def compute_l2_freshness(
    daily_health: Any,
    dashboard: Any = None,
    baseline_rhr: float | None = None,
) -> dict:
    """Return {total, breakdown} for today's readiness."""
    if daily_health is None:
        return {"total": 50.0, "breakdown": {k: 50.0 for k in L2_WEIGHTS}}

    ati = _get(daily_health, "ati")
    cti = _get(daily_health, "cti")
    rhr = _get(daily_health, "rhr")
    fatigue = _get(daily_health, "fatigue")

    # TSB sub-score.
    tsb = None
    if ati is not None and cti is not None:
        tsb = cti - ati
    tsb_score = _tsb_to_score(tsb)

    # RHR sub-score.
    rhr_score = _rhr_to_score(rhr, baseline_rhr)

    # HRV sub-score (snapshot-based until daily sleep HRV exists).
    hrv_score = _hrv_to_score(dashboard)

    # Fatigue sub-score (COROS 0-100; lower is better).
    if fatigue is None:
        fatigue_score = 50.0
    else:
        fatigue_score = _clamp(100.0 - float(fatigue), 0.0, 100.0)

    breakdown = {
        "tsb_score": round(tsb_score, 2),
        "rhr_score": round(rhr_score, 2),
        "hrv_score": round(hrv_score, 2),
        "fatigue_score": round(fatigue_score, 2),
    }
    total = sum(breakdown[k] * w for k, w in L2_WEIGHTS.items())
    return {"total": round(total, 2), "breakdown": breakdown, "tsb": tsb}


def _tsb_to_score(tsb: float | None) -> float:
    if tsb is None:
        return 50.0
    # Race-ready zone [-10, 10] → 100; decay outside.
    if -10 <= tsb <= 10:
        return 100.0
    if tsb > 10:
        return _clamp(100.0 - (tsb - 10) * 2.0, 0.0, 100.0)
    # tsb < -10: overload penalty.
    return _clamp(100.0 - (abs(tsb) - 10) * 2.5, 0.0, 100.0)


def _rhr_to_score(rhr: int | None, baseline_rhr: float | None) -> float:
    if rhr is None or baseline_rhr is None:
        return 50.0 if rhr is None else 80.0
    delta = rhr - baseline_rhr
    if delta <= 0:
        return 100.0
    return _clamp(100.0 - delta * 5.0, 0.0, 100.0)


def _hrv_to_score(dashboard: Any) -> float:
    if dashboard is None:
        return 50.0
    avg = _get(dashboard, "avg_sleep_hrv")
    lo = _get(dashboard, "hrv_normal_low")
    hi = _get(dashboard, "hrv_normal_high")
    if avg is None:
        return 50.0
    if lo is None or hi is None or lo >= hi:
        return 70.0  # we have a value but no band — moderate default
    if lo <= avg <= hi:
        return 100.0
    if avg < lo:
        return _clamp(100.0 - (lo - avg) * 4.0, 0.0, 100.0)
    return _clamp(100.0 - (avg - hi) * 2.0, 0.0, 100.0)


# ---------------------------------------------------------------------------
# L3 — 6-dimension rolling ability scores (evidence-driven).
# Each returns (score_0_100, evidence_label_ids: list[str], details: dict).
# ---------------------------------------------------------------------------

def _is_running(activity: Any) -> bool:
    sport = _get(activity, "sport_type")
    if sport is None:
        return True
    return sport in {100, 101, 102, 103, 104}


def compute_l3_aerobic(
    activities: Sequence[Any],
    target_hr: int = AEROBIC_TARGET_HR,
) -> tuple[float, list[str], dict]:
    """Aerobic base score: best (fastest) single E/M run pace near target_hr over the window.

    Best-performance semantics: ability reflects peak demonstrated aerobic efficiency,
    not current-week volume. The list passed in should already be scoped to the desired
    window (typically ABILITY_LOOKBACK_DAYS).

    Evidence: running activities ≥5 km with avg_hr within ±AEROBIC_HR_TOLERANCE of target_hr.
    Returns best single qualifying run; `evidence` holds the label of that run.
    """
    best_pace: float | None = None
    best_label: str | None = None
    n_qualifying = 0
    for a in activities:
        if not _is_running(a):
            continue
        hr = _get(a, "avg_hr")
        pace = _get(a, "avg_pace_s_km")
        dist = _get(a, "distance_m") or 0
        if pace is None or hr is None:
            continue
        # distance_m column is a misnomer: real COROS data stores KM (14km run → 14.0).
        dist_km = dist / 1000.0 if dist > 500 else dist
        if dist_km < AEROBIC_MIN_DISTANCE_KM:
            continue
        if abs(hr - target_hr) > AEROBIC_HR_TOLERANCE:
            continue
        n_qualifying += 1
        pace_f = float(pace)
        if best_pace is None or pace_f < best_pace:
            best_pace = pace_f
            best_label = str(_get(a, "label_id") or "") or None
    if best_pace is None:
        return 0.0, [], {"best_pace_s_km": None, "n_runs": 0}
    # Score: 80 at anchor pace, POINTS_PER_SEC per second faster/slower.
    score = _clamp(
        AEROBIC_SCORE_BASE + (AEROBIC_ANCHOR_PACE_S_KM - best_pace) * AEROBIC_POINTS_PER_SEC,
        0.0,
        100.0,
    )
    evidence = [best_label] if best_label else []
    return (
        round(score, 2),
        evidence,
        {"best_pace_s_km": round(best_pace, 1), "n_runs": n_qualifying},
    )


AEROBIC_SCORE_BASE = 80.0  # score at the anchor pace


def _is_rest_lap(lap: Any) -> bool:
    """Lap is a rest/recovery segment, not a sustained training effort.

    Criteria (any one triggers):
      - exercise_type in (3 cooldown, 4 recovery/rest)
      - avg_pace slower than 8:00/km (walk/jog recovery) when ex_type is unknown
    """
    ex = _get(lap, "exercise_type")
    try:
        ex_int = int(ex) if ex is not None else None
    except (TypeError, ValueError):
        ex_int = None
    if ex_int in (3, 4):
        return True
    if ex_int is None:
        p = _get(lap, "avg_pace")
        if p is not None and p > 480:  # slower than 8:00/km → walk/rest
            return True
    return False


def _best_sustained_pace_s_km(
    laps: Sequence[Any], min_seconds: float
) -> tuple[float | None, float]:
    """Find the fastest contiguous lap-window of ≥ min_seconds duration.

    Rest/recovery laps break the sequence — a threshold effort interrupted by
    3-minute standing rest isn't a sustained 30-min tempo. This prevents
    interval sessions from being misread as continuous LT blocks.

    Returns (pace_s_km, achieved_duration_s) or (None, 0) if no window qualifies.
    """
    best_pace: float | None = None
    best_dur = 0.0
    n = len(laps)
    if n == 0:
        return None, 0.0
    durs = [_get(lp, "duration_s") or 0 for lp in laps]
    dists = [_get(lp, "distance_m") or 0 for lp in laps]
    is_rest = [_is_rest_lap(lp) for lp in laps]
    # laps in models use distance_m in km units (models.py Lap.from_api divides
    # raw API value by 100_000). Handle fixture meter-scale via magnitude heuristic.
    km_scale = all(d < 200 for d in dists if d)
    for i in range(n):
        if is_rest[i]:
            continue
        dur = 0.0
        dist_km = 0.0
        for j in range(i, n):
            if is_rest[j]:
                break  # rest lap interrupts the sustained block
            dur += durs[j]
            d = dists[j]
            dist_km += d if km_scale else d / 1000.0
            if dur >= min_seconds and dist_km > 0:
                pace = dur / dist_km
                if best_pace is None or pace < best_pace:
                    best_pace = pace
                    best_dur = dur
                break  # further extension is slower
    return best_pace, best_dur


def compute_l3_lt(
    activities_28d: Sequence[Any],
) -> tuple[float, list[str], dict]:
    """Lactate threshold: fastest sustained ≥20-min pace within 28 days."""
    evidence: list[str] = []
    best_overall: float | None = None
    for a in activities_28d:
        if not _is_running(a):
            continue
        laps = _get(a, "laps") or []
        if not laps:
            continue
        pace, dur = _best_sustained_pace_s_km(laps, LT_MIN_DURATION_S)
        if pace is None:
            continue
        if best_overall is None or pace < best_overall:
            best_overall = pace
            evidence = [str(_get(a, "label_id"))] if _get(a, "label_id") else []
    if best_overall is None:
        return 0.0, [], {"best_pace_s_km": None}
    score = _clamp(
        80.0 + (LT_ANCHOR_PACE_S_KM - best_overall) * LT_POINTS_PER_SEC,
        0.0,
        100.0,
    )
    return round(score, 2), evidence, {"best_pace_s_km": round(best_overall, 1)}


def _marathon_time_to_vdot_table(time_s: float) -> float | None:
    """Inverse lookup of DANIELS_VDOT_TO_MARATHON_S.

    Daniels's empirical race-equivalence table is better calibrated than the
    `daniels_vdot` formula for long-duration events (where formula %VO2max
    assumptions break down). Given an actual marathon finish time, interpolate
    the closest VDOT. Returns None if time is non-positive.
    """
    if time_s <= 0:
        return None
    table = DANIELS_VDOT_TO_MARATHON_S
    vdots = sorted(table.keys())
    # Times decrease as VDOT increases; clamp outside range.
    if time_s >= table[vdots[0]]:
        return float(vdots[0])
    if time_s <= table[vdots[-1]]:
        return float(vdots[-1])
    for i in range(len(vdots) - 1):
        t_lo, t_hi = table[vdots[i]], table[vdots[i + 1]]  # t_lo > t_hi
        if t_hi <= time_s <= t_lo:
            frac = (t_lo - time_s) / (t_lo - t_hi) if t_lo != t_hi else 0.0
            return vdots[i] + frac * (vdots[i + 1] - vdots[i])
    return None


def _extract_interval_reps(activity: Any) -> list[tuple[float, float]]:
    """Return list of (distance_m, time_s) for laps that look like intervals.

    Heuristic: laps tagged as exercise_type == 2 (training) with distance
    ≥ VO2MAX_INTERVAL_MIN_DIST_M (as meters) OR ≥ 0.9 km in km-scale models.
    """
    reps: list[tuple[float, float]] = []
    laps = _get(activity, "laps") or []
    for lp in laps:
        ex = _get(lp, "exercise_type")
        if ex is not None and ex != 2:
            continue
        d = _get(lp, "distance_m") or 0
        t = _get(lp, "duration_s") or 0
        if t <= 0:
            continue
        # Distance detection (see _best_sustained_pace_s_km comment).
        d_m = d * 1000.0 if d < 200 else d
        if d_m < VO2MAX_INTERVAL_MIN_DIST_M:
            continue
        reps.append((d_m, t))
    return reps


def compute_l3_vo2max(
    activities_56d: Sequence[Any],
    daily_health_7d: Sequence[Any] | None = None,
    hr_max: int = 185,
) -> tuple[float, list[str], dict]:
    """VO2max estimate from three independent methods; main = Daniels VDOT.

    Returns (score, evidence, details) where details includes:
      vo2max_primary, vo2max_secondary, vo2max_floor,
      vo2max_used, vo2max_used_vdot, vo2max_source.
    """
    # ---- Primary: Daniels VDOT from best interval-set or best-effort race ----
    best_vdot = 0.0
    best_evidence: list[str] = []
    for a in activities_56d:
        if not _is_running(a):
            continue
        reps = _extract_interval_reps(a)
        if len(reps) >= VO2MAX_INTERVAL_MIN_REPS:
            # Avg pace across reps → synthetic race distance.
            total_d = sum(d for d, _ in reps)
            total_t = sum(t for _, t in reps)
            vdot = daniels_vdot(total_d, total_t)
            if vdot > best_vdot:
                best_vdot = vdot
                lid = _get(a, "label_id")
                best_evidence = [str(lid)] if lid else []
        # Also consider the run as a whole if it looks like a 5K/10K race.
        dist_m = _get(a, "distance_m") or 0
        dur_s = _get(a, "duration_s") or 0
        # distance_m on Activity is METERS (see models.py Activity.from_api
        # which stores raw `distance` field — API value may already be m).
        # Normalize: if value is <500 we assume km-scale, else meters.
        if 0 < dist_m < 500:
            dist_m_norm = dist_m * 1000.0
        else:
            dist_m_norm = dist_m
        train_type = _get(a, "train_type")
        is_race_like = (
            (4800 <= dist_m_norm <= 10500)
            and dur_s > 0
            and (train_type in (None, "Interval", "VO2 Max", "Threshold") or dur_s < 3600)
        )
        if is_race_like:
            vdot = daniels_vdot(dist_m_norm, dur_s)
            if vdot > best_vdot:
                best_vdot = vdot
                lid = _get(a, "label_id")
                best_evidence = [str(lid)] if lid else []

    # Marathon race correction: Daniels's formula underestimates %VO2max for 3+ hour
    # efforts. For full marathons, use the empirical table inverse (Daniels's published
    # race-equivalence values) instead of the formula, then take max with best formula VDOT.
    for a in activities_56d:
        if not _is_running(a):
            continue
        dist = _get(a, "distance_m") or 0
        dist_m = dist * 1000.0 if 0 < dist < 500 else dist
        dur_s = _get(a, "duration_s") or 0
        # Full marathon ± 1.3km, duration 2-6h
        if 41000 <= dist_m <= 43500 and 7200 <= dur_s <= 21600:
            table_vdot = _marathon_time_to_vdot_table(float(dur_s))
            if table_vdot is not None and table_vdot > best_vdot:
                best_vdot = float(table_vdot)
                lid = _get(a, "label_id")
                best_evidence = [str(lid)] if lid else []

    vo2max_primary = best_vdot if best_vdot > 0 else 0.0

    # ---- Secondary: HR-pace regression over recent easy runs ----
    vo2max_secondary = _vo2max_from_hr_pace(activities_56d, hr_max)

    # ---- Floor: Uth–Sørensen using RHR median from last 7 days ----
    rhr_med = 0.0
    if daily_health_7d:
        rhr_med = _median(
            [_get(r, "rhr") for r in daily_health_7d if _get(r, "rhr") is not None]
        )
    vo2max_floor = uth_sorensen_vo2max(hr_max, rhr_med) if rhr_med > 0 else 0.0

    # Select used value by priority.
    if vo2max_primary > 0:
        used, source, used_vdot = vo2max_primary, "primary", vo2max_primary
    elif vo2max_secondary > 0:
        used, source = vo2max_secondary, "secondary"
        used_vdot = _vo2max_to_vdot_approx(vo2max_secondary)
    elif vo2max_floor > 0:
        used, source = vo2max_floor, "floor"
        used_vdot = _vo2max_to_vdot_approx(vo2max_floor)
    else:
        used, source, used_vdot = 0.0, "none", 0.0

    # Normalize to 0-100 via (used_vdot − reference)·points_per_vdot + 80.
    if used_vdot > 0:
        score = _clamp(
            VO2MAX_SCORE_AT_REF + (used_vdot - VO2MAX_REFERENCE_VDOT) * VO2MAX_POINTS_PER_VDOT,
            0.0,
            100.0,
        )
    else:
        score = 0.0

    details = {
        "vo2max_primary": round(vo2max_primary, 2) if vo2max_primary else None,
        "vo2max_secondary": round(vo2max_secondary, 2) if vo2max_secondary else None,
        "vo2max_floor": round(vo2max_floor, 2) if vo2max_floor else None,
        "vo2max_used": round(used, 2) if used else None,
        "vo2max_used_vdot": round(used_vdot, 2) if used_vdot else None,
        "vo2max_source": source,
    }
    return round(score, 2), best_evidence, details


def _vo2max_from_hr_pace(
    activities: Sequence[Any], hr_max: int
) -> float:
    """Sub-max HR-pace regression → extrapolate to HRmax → ACSM VO2max."""
    points: list[tuple[float, float]] = []  # (hr, pace_s_km)
    lo = hr_max * EASY_HR_LOW_FACTOR
    hi = hr_max * EASY_HR_HIGH_FACTOR
    for a in activities:
        if not _is_running(a):
            continue
        hr = _get(a, "avg_hr")
        pace = _get(a, "avg_pace_s_km")
        if hr is None or pace is None:
            continue
        if not (lo <= hr <= hi):
            continue
        points.append((float(hr), float(pace)))
    if len(points) < 3:
        return 0.0
    reg = _linreg(points)
    if reg is None:
        return 0.0
    slope, intercept = reg
    pace_at_hrmax = slope * hr_max + intercept
    if pace_at_hrmax <= 0:
        return 0.0
    return acsm_running_vo2(pace_at_hrmax)


def _vo2max_to_vdot_approx(vo2: float) -> float:
    """Loose inverse of Daniels VDOT — approximate marathon VDOT for a given
    VO2max ml/kg/min.  VDOT ≈ VO2max since both are ml/kg/min and marathon
    pace sits near 84-88% VO2max.
    """
    # Empirical rule-of-thumb: VDOT ≈ VO2max − 2 to VO2max, because VDOT is a
    # race-performance derivative (higher than pure lab VO2max by a touch).
    return vo2


def compute_l3_endurance(
    activities_28d: Sequence[Any],
) -> tuple[float, list[str], dict]:
    """Endurance: longest run in last 28 days, adjusted by HR drift."""
    evidence: list[str] = []
    best_km = 0.0
    best_drift = 0.0
    for a in activities_28d:
        if not _is_running(a):
            continue
        dist = _get(a, "distance_m") or 0
        # Normalize to km.
        dist_km = dist / 1000.0 if dist > 500 else dist
        if dist_km < ENDURANCE_MIN_DISTANCE_KM:
            continue
        if dist_km <= best_km:
            continue
        # Drift from timeseries when available.
        drift = 0.0
        ts = _get(a, "timeseries") or []
        laps = _get(a, "laps") or []
        if ts or laps:
            drift = _compute_hr_decoupling(ts, laps)
        best_km = dist_km
        best_drift = drift
        lid = _get(a, "label_id")
        evidence = [str(lid)] if lid else []
    if best_km == 0:
        return 0.0, [], {"longest_km": None, "drift": None}
    score = 80.0 + (best_km - ENDURANCE_ANCHOR_KM) * ENDURANCE_POINTS_PER_KM
    if best_drift > 0.08:
        score -= ENDURANCE_DRIFT_PENALTY
    score = _clamp(score, 0.0, 100.0)
    return (
        round(score, 2),
        evidence,
        {"longest_km": round(best_km, 1), "drift": round(best_drift, 4)},
    )


def compute_l3_economy(
    activities_28d: Sequence[Any],
) -> tuple[float, list[str], dict]:
    """Economy: median cadence across laps near 4:50/km target pace."""
    evidence: list[str] = []
    cadences: list[int] = []
    for a in activities_28d:
        if not _is_running(a):
            continue
        laps = _get(a, "laps") or []
        took = False
        for lp in laps:
            pace = _get(lp, "avg_pace")
            cad = _get(lp, "avg_cadence")
            if pace is None or cad is None:
                continue
            if 280 <= pace <= 300:  # 4:40–5:00/km window around 4:50
                cadences.append(int(cad))
                took = True
        if took:
            lid = _get(a, "label_id")
            if lid:
                evidence.append(str(lid))
    if not cadences:
        return 0.0, [], {"median_cadence": None}
    med = _median(cadences)
    score = _clamp(
        80.0 + (med - ECONOMY_ANCHOR_CADENCE) * ECONOMY_POINTS_PER_SPM,
        0.0,
        100.0,
    )
    return round(score, 2), evidence, {"median_cadence": round(med, 1)}


def compute_l3_recovery(
    l2_totals_7d: Sequence[float],
) -> tuple[float, list[str], dict]:
    """7-day average of L2 composite."""
    vals = [v for v in l2_totals_7d if v is not None]
    if not vals:
        return 50.0, [], {"n_days": 0}
    avg = sum(vals) / len(vals)
    return round(_clamp(avg, 0.0, 100.0), 2), [], {"n_days": len(vals)}


# ---------------------------------------------------------------------------
# L4 composite + marathon estimate.
# ---------------------------------------------------------------------------

def compute_l4_composite(l3: Mapping[str, float]) -> float:
    total = 0.0
    wsum = 0.0
    for k, w in L4_WEIGHTS.items():
        v = l3.get(k)
        if v is None:
            continue
        total += float(v) * w
        wsum += w
    if wsum <= 0:
        return 0.0
    return round(total / wsum * sum(L4_WEIGHTS.values()), 2)


def estimate_marathon_time_s(l3: Mapping[str, Any]) -> int | None:
    """Estimate finishing time from VDOT, with endurance-dimension correction.

    Expects l3 to carry a `vo2max_used_vdot` key (produced by compute_l3_vo2max).
    Falls back to `vo2max` score → inverse anchor.
    """
    vdot = None
    if "vo2max_used_vdot" in l3 and l3.get("vo2max_used_vdot"):
        vdot = float(l3["vo2max_used_vdot"])
    elif "vo2max" in l3 and l3.get("vo2max"):
        # Inverse of the anchor: score → VDOT.
        score = float(l3["vo2max"])
        vdot = VO2MAX_REFERENCE_VDOT + (score - VO2MAX_SCORE_AT_REF) / VO2MAX_POINTS_PER_VDOT
    if vdot is None or vdot <= 0:
        return None
    base_s = vdot_to_marathon_s(vdot)
    if base_s is None:
        return None
    # Endurance correction: <70 → +2%, >85 → −2%, linear between.
    endurance = l3.get("endurance")
    if endurance is not None:
        e = float(endurance)
        if e <= 70:
            factor = 1.02
        elif e >= 85:
            factor = 0.98
        else:
            # 70→+2%, 85→−2% — linear
            factor = 1.02 - (e - 70) / (85 - 70) * 0.04
        base_s = base_s * factor
    return int(round(base_s))


# ---------------------------------------------------------------------------
# Contribution (per-activity L3 delta before/after).
# ---------------------------------------------------------------------------

def compute_contribution(
    activity: Any,
    prior_l3: Mapping[str, float],
    posterior_l3: Mapping[str, float],
) -> dict[str, float]:
    """Difference posterior − prior for each L3 dimension."""
    out: dict[str, float] = {}
    for k in L4_WEIGHTS.keys():
        p = prior_l3.get(k)
        q = posterior_l3.get(k)
        if p is None or q is None:
            out[k] = 0.0
            continue
        out[k] = round(float(q) - float(p), 2)
    return out


# ---------------------------------------------------------------------------
# Orchestration: compute_ability_snapshot.
# THIS is the only function in this module allowed to touch `db._conn`.
# ---------------------------------------------------------------------------

def compute_ability_snapshot(
    db: Any,
    date: str,
    hr_max: int = 185,
) -> dict:
    """Compute full snapshot {l1 (latest), l2, l3, l4, marathon_s} for `date`.

    `date` is an ISO YYYY-MM-DD string.  All date filtering uses Shanghai
    local time (UTC+8) as project memory requires.
    """
    if db is None:
        return _empty_snapshot(date)

    try:
        conn = db._conn
    except AttributeError:
        return _empty_snapshot(date)

    # Fetch activities across the full ability window (default 1 year).
    # All L3 "ability" dimensions use best-performance semantics over this window.
    try:
        activities = _fetch_recent_activities(conn, date, days=ABILITY_LOOKBACK_DAYS)
    except Exception:
        activities = []

    # Fetch daily_health last 28 days + dashboard snapshot.
    try:
        health_28d = _fetch_recent_daily_health(conn, date, days=28)
    except Exception:
        health_28d = []
    try:
        dashboard = _fetch_dashboard(conn)
    except Exception:
        dashboard = None

    # L3 dimensions use the full ability window (best-performance semantics).
    # L2/recovery use short windows (they're "current state", not "ability").
    health_7d = [h for h in health_28d if _within_days(h, date, 7, field="date")]

    # Baseline RHR = median over last 28 days.
    baseline_rhr = _median(
        [_get(r, "rhr") for r in health_28d if _get(r, "rhr") is not None]
    )
    if baseline_rhr == 0:
        baseline_rhr = None

    # Today's health row (if any). Handle both YYYYMMDD (real data) and YYYY-MM-DD (fixtures).
    _date_compact = date.replace("-", "")
    today_health = next(
        (
            h for h in health_28d
            if str(_get(h, "date") or "").replace("-", "") == _date_compact
        ),
        None,
    )

    # Compute L2 for today + last 7 days (needed for recovery).
    l2_today = compute_l2_freshness(today_health, dashboard, baseline_rhr)
    l2_7d_totals: list[float] = []
    for day_row in health_7d:
        lv = compute_l2_freshness(day_row, dashboard, baseline_rhr)
        l2_7d_totals.append(lv.get("total", 0.0))

    # L3 dimensions (all over the full ability window).
    aerobic_score, aerobic_ev, aerobic_det = compute_l3_aerobic(activities)
    lt_score, lt_ev, lt_det = compute_l3_lt(activities)
    vo2_score, vo2_ev, vo2_det = compute_l3_vo2max(activities, health_7d, hr_max)
    end_score, end_ev, end_det = compute_l3_endurance(activities)
    eco_score, eco_ev, eco_det = compute_l3_economy(activities)
    rec_score, _rec_ev, rec_det = compute_l3_recovery(l2_7d_totals)

    l3 = {
        "aerobic": aerobic_score,
        "lt": lt_score,
        "vo2max": vo2_score,
        "endurance": end_score,
        "economy": eco_score,
        "recovery": rec_score,
        # Carried through for marathon estimator.
        "vo2max_used_vdot": vo2_det.get("vo2max_used_vdot") or 0.0,
    }

    # L4.
    l4_composite = compute_l4_composite(
        {k: l3[k] for k in L4_WEIGHTS.keys()}
    )
    marathon_training_s = estimate_marathon_time_s(l3)
    # Race-day scenarios: training observation is a lower bound on race performance.
    if marathon_training_s:
        marathon_race_s = int(round(marathon_training_s * (1.0 - RACE_DAY_BOOST_PCT)))
        marathon_best_case_s = int(round(marathon_training_s * (1.0 - BEST_CASE_BOOST_PCT)))
    else:
        marathon_race_s = None
        marathon_best_case_s = None
    # Default headline = typical race-day estimate.
    marathon_s = marathon_race_s

    # L1 from most recent activity (if within the window).
    latest_l1 = None
    if activities:
        latest = activities[0]
        latest_l1 = compute_l1_quality(latest, plan_target=None, hr_max=hr_max)

    evidence_activity_ids = list(
        dict.fromkeys(  # preserve order, dedupe
            aerobic_ev + lt_ev + vo2_ev + end_ev + eco_ev
        )
    )

    return {
        "date": date,
        "l1_latest": latest_l1,
        "l2_freshness": l2_today,
        "l3_dimensions": {
            "aerobic": {"score": aerobic_score, "evidence": aerobic_ev, **aerobic_det},
            "lt": {"score": lt_score, "evidence": lt_ev, **lt_det},
            "vo2max": {"score": vo2_score, "evidence": vo2_ev, **vo2_det},
            "endurance": {"score": end_score, "evidence": end_ev, **end_det},
            "economy": {"score": eco_score, "evidence": eco_ev, **eco_det},
            "recovery": {"score": rec_score, **rec_det},
        },
        "l4_composite": l4_composite,
        "l4_marathon_estimate_s": marathon_s,
        "distance_to_sub_2_50_s": (marathon_s - 10200) if marathon_s else None,
        "marathon_estimates": {
            "training_s": marathon_training_s,      # no race-day boost
            "race_s": marathon_race_s,              # −3%, default headline
            "best_case_s": marathon_best_case_s,    # −5%, stretch ceiling
            "race_day_boost_pct": RACE_DAY_BOOST_PCT,
            "best_case_boost_pct": BEST_CASE_BOOST_PCT,
        },
        "evidence_activity_ids": evidence_activity_ids,
        "baseline_rhr": baseline_rhr,
    }


def _empty_snapshot(date: str) -> dict:
    zeros = {k: 0.0 for k in L4_WEIGHTS}
    return {
        "date": date,
        "l1_latest": None,
        "l2_freshness": {"total": 50.0, "breakdown": {k: 50.0 for k in L2_WEIGHTS}},
        "l3_dimensions": {
            k: {"score": 0.0, "evidence": []} for k in L4_WEIGHTS
        },
        "l4_composite": 0.0,
        "l4_marathon_estimate_s": None,
        "distance_to_sub_2_50_s": None,
        "marathon_estimates": {
            "training_s": None,
            "race_s": None,
            "best_case_s": None,
            "race_day_boost_pct": RACE_DAY_BOOST_PCT,
            "best_case_boost_pct": BEST_CASE_BOOST_PCT,
        },
        "evidence_activity_ids": [],
        "baseline_rhr": None,
    }


# ---------------------------------------------------------------------------
# DB helpers used ONLY by compute_ability_snapshot.
# ---------------------------------------------------------------------------

def _fetch_recent_activities(conn: Any, date_iso: str, days: int) -> list[dict]:
    """Return running activities within `days` days up to `date_iso`.

    Each item has: label_id, sport_type, date, distance_m, duration_s,
    avg_pace_s_km, avg_hr, max_hr, avg_cadence, train_type, laps[],
    timeseries[].
    """
    # Use Shanghai local-time filter per project memory.
    sql = """
      SELECT label_id, name, sport_type, date, distance_m, duration_s,
             avg_pace_s_km, avg_hr, max_hr, avg_cadence, vo2max, train_type
      FROM activities
      WHERE sport_type IN (100,101,102,103,104)
        AND date(datetime(date, '+8 hours')) >= date(?, ?)
        AND date(datetime(date, '+8 hours')) <= date(?)
      ORDER BY date DESC
    """
    rows = conn.execute(sql, (date_iso, f"-{days} days", date_iso)).fetchall()
    out: list[dict] = []
    for r in rows:
        d = dict(r)
        # Attach laps + timeseries.
        laps = [
            dict(x) for x in conn.execute(
                "SELECT lap_index, lap_type, distance_m, duration_s, avg_pace, "
                "avg_hr, max_hr, avg_cadence, exercise_type FROM laps "
                "WHERE label_id = ? ORDER BY lap_index",
                (d["label_id"],),
            ).fetchall()
        ]
        ts = [
            dict(x) for x in conn.execute(
                "SELECT heart_rate, speed, cadence FROM timeseries "
                "WHERE label_id = ? ORDER BY id LIMIT 3000",
                (d["label_id"],),
            ).fetchall()
        ]
        d["laps"] = laps
        d["timeseries"] = ts
        out.append(d)
    return out


def _fetch_recent_daily_health(conn: Any, date_iso: str, days: int) -> list[dict]:
    # daily_health.date can be YYYYMMDD (real COROS data) or YYYY-MM-DD (some fixtures).
    # Compute bounds in both formats and filter via OR so either storage shape works.
    from datetime import date as _date, timedelta
    end = _date.fromisoformat(date_iso)
    start = end - timedelta(days=days)
    rows = conn.execute(
        "SELECT * FROM daily_health "
        "WHERE (date >= ? AND date <= ?) OR (date >= ? AND date <= ?) "
        "ORDER BY date DESC",
        (
            start.strftime("%Y%m%d"), end.strftime("%Y%m%d"),
            start.isoformat(), end.isoformat(),
        ),
    ).fetchall()
    return [dict(r) for r in rows]


def _fetch_dashboard(conn: Any) -> dict | None:
    row = conn.execute("SELECT * FROM dashboard WHERE id = 1").fetchone()
    return dict(row) if row else None


def _within_days(obj: Any, end_iso: str, days: int, field: str = "date") -> bool:
    val = _get(obj, field)
    if not val:
        return False
    # Activities store ISO timestamps (2026-04-24T...).
    # daily_health can be YYYYMMDD (real COROS) or YYYY-MM-DD (fixtures).
    # Strip dashes first so both formats normalize to YYYYMMDD.
    s = str(val)[:19].replace("-", "").replace("T", "")  # keep date+time chars, drop separators
    end_compact = end_iso.replace("-", "")
    try:
        from datetime import date as _date
        end = _date(int(end_compact[:4]), int(end_compact[4:6]), int(end_compact[6:8]))
        cur = _date(int(s[:4]), int(s[4:6]), int(s[6:8]))
        delta = (end - cur).days
        return 0 <= delta <= days
    except Exception:
        return False


__all__ = [
    # Constants
    "VO2MAX_REFERENCE_VDOT",
    "VO2MAX_SCORE_AT_REF",
    "VO2MAX_POINTS_PER_VDOT",
    "AEROBIC_ANCHOR_PACE_S_KM",
    "LT_ANCHOR_PACE_S_KM",
    "ENDURANCE_ANCHOR_KM",
    "ECONOMY_ANCHOR_CADENCE",
    "L1_WEIGHTS",
    "L2_WEIGHTS",
    "L4_WEIGHTS",
    "DANIELS_VDOT_TO_MARATHON_S",
    # Daniels / VO2max primitives
    "daniels_vo2_required",
    "daniels_pct_vo2max",
    "daniels_vdot",
    "acsm_running_vo2",
    "uth_sorensen_vo2max",
    "vdot_to_marathon_s",
    # L1
    "compute_l1_quality",
    # L2
    "compute_l2_freshness",
    # L3
    "compute_l3_aerobic",
    "compute_l3_lt",
    "compute_l3_vo2max",
    "compute_l3_endurance",
    "compute_l3_economy",
    "compute_l3_recovery",
    # L4
    "compute_l4_composite",
    "estimate_marathon_time_s",
    # Contribution + entry
    "compute_contribution",
    "compute_ability_snapshot",
]
