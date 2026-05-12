"""Race-prediction endpoints — US-006.

Two read-only endpoints that expose per-distance race-time predictions derived
from the ability_snapshot VO2max column (L3 vo2max dimension score → VDOT)
and from the four Daniels distance tables (FM/HM from existing tables;
5K/10K numerically solved from the Daniels formulas).

  GET /api/{user}/race-predictions
  GET /api/{user}/race-predictions/history?days=180
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from stride_core.ability import (
    ABILITY_MODEL_VERSION,
    VDOT_CLAMP_MAX,
    VDOT_CLAMP_MIN,
    VO2MAX_REFERENCE_VDOT,
    VO2MAX_SCORE_AT_REF,
    VO2MAX_POINTS_PER_VDOT,
    daniels_pct_vo2max,
    daniels_vo2_required,
    vdot_to_marathon_s,
    vdot_to_half_marathon_s,
)

from ..content_store import read_json
from ..deps import get_db

router = APIRouter()
logger = logging.getLogger(__name__)

_SHANGHAI_TZ = timezone(timedelta(hours=8))

# Canonical race distances in metres used by the Daniels solver.
_DIST_M = {
    "5K": 5000.0,
    "10K": 10000.0,
    "HM": 21097.5,
    "FM": 42195.0,
}

# Search bounds for the numerical VDOT→time solver (seconds).
# Wide enough to cover VDOT 30–85 at each distance.
_SOLVER_BOUNDS = {
    "5K":  (600,  3600),   # ~10 min – 60 min
    "10K": (1200, 7200),   # ~20 min – 2 h
    "HM":  (2400, 10800),  # ~40 min – 3 h
    "FM":  (5400, 21600),  # ~1.5 h – 6 h
}


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

def _vdot_from_score(score: float) -> float:
    """Invert the L3 VO2max scoring formula to recover the underlying VDOT.

    Formula (from ability.py):
        score = VO2MAX_SCORE_AT_REF + (vdot - VO2MAX_REFERENCE_VDOT) * VO2MAX_POINTS_PER_VDOT
    """
    vdot = VO2MAX_REFERENCE_VDOT + (score - VO2MAX_SCORE_AT_REF) / VO2MAX_POINTS_PER_VDOT
    return max(VDOT_CLAMP_MIN, min(VDOT_CLAMP_MAX, vdot))


def _daniels_race_time_s(distance_m: float, vdot: float) -> float:
    """Numerically solve for race time T such that pct(T)*vdot == vo2_req(distance, T).

    Uses bisection (simple, no external deps).  Returns 0.0 on failure.
    """
    if vdot <= 0 or distance_m <= 0:
        return 0.0

    dist_key = next(
        (k for k, v in _DIST_M.items() if abs(v - distance_m) < 1),
        None,
    )
    if dist_key in ("FM", "HM"):
        fn = vdot_to_marathon_s if dist_key == "FM" else vdot_to_half_marathon_s
        result = fn(vdot)
        return float(result) if result is not None else 0.0

    # Bisection for 5K / 10K.
    # f(T) = pct(T) * vdot - vo2_req(distance, T)  — find T where f(T) = 0.
    def f(t: float) -> float:
        pct = daniels_pct_vo2max(t)
        req = daniels_vo2_required(distance_m, t)
        return pct * vdot - req

    # Determine search bounds.
    lo, hi = _SOLVER_BOUNDS.get(dist_key, (600, 21600))
    f_lo, f_hi = f(lo), f(hi)
    # f is strictly decreasing in T for most practical ranges: at short T,
    # pct is high and pace is fast, so pct*vdot >> req; at long T, req
    # approaches 0 but pct*vdot > 0, meaning f(T) > 0 always for solvable
    # inputs. In practice the sign flip occurs reliably within the bounds.
    if f_lo * f_hi > 0:
        # Fallback: use Daniels formula directly (less accurate for short races).
        return 0.0

    for _ in range(60):
        mid = (lo + hi) / 2.0
        f_mid = f(mid)
        if abs(f_mid) < 1e-6 or (hi - lo) < 0.5:
            return mid
        if f_lo * f_mid < 0:
            hi = mid
            f_hi = f_mid
        else:
            lo = mid
            f_lo = f_mid
    return (lo + hi) / 2.0


def _predictions_from_vdot(vdot: float) -> dict[str, dict[str, int]]:
    """Return predicted times + paces for all four canonical distances."""
    result: dict[str, dict[str, int]] = {}
    for label, dist_m in _DIST_M.items():
        t = _daniels_race_time_s(dist_m, vdot)
        if t <= 0:
            result[label] = {"predicted_time_sec": 0, "predicted_pace_sec_per_km": 0}
        else:
            pace = t / (dist_m / 1000.0)
            result[label] = {
                "predicted_time_sec": int(round(t)),
                "predicted_pace_sec_per_km": int(round(pace)),
            }
    return result


def _read_training_goal(user: str) -> dict[str, Any] | None:
    item = read_json(f"{user}/training_goal.json")
    if item is None:
        return None
    data, _ = item
    if not isinstance(data, dict):
        return None
    return data.get("current") if isinstance(data.get("current"), dict) else None


def _parse_finish_time(raw: str | None) -> int | None:
    """Parse H:MM:SS or M:SS → seconds, return None on failure."""
    if not raw:
        return None
    parts = raw.strip().split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
    except (ValueError, TypeError):
        pass
    return None


def _build_target_gap(
    goal: dict[str, Any] | None,
    distances: dict[str, dict[str, int]],
) -> dict[str, Any] | None:
    if goal is None:
        return None
    if goal.get("type") != "race":
        return None
    target_time_raw = goal.get("target_finish_time")
    race_distance = goal.get("race_distance")
    if not target_time_raw or not race_distance:
        return None
    target_s = _parse_finish_time(target_time_raw)
    if target_s is None:
        return None
    # Map race_distance values from TrainingGoal to our distance labels.
    # TrainingGoal uses: "5K", "10K", "HM", "FM", "trail".
    dist_map = {"5K": "5K", "10K": "10K", "HM": "HM", "FM": "FM"}
    label = dist_map.get(race_distance)
    if label is None:
        return None
    current_s = (distances.get(label) or {}).get("predicted_time_sec", 0)
    if current_s <= 0:
        return None
    gap = current_s - target_s
    return {
        "distance": label,
        "target_time_sec": target_s,
        "current_time_sec": current_s,
        "gap_sec": gap,
        "on_track": gap <= 0,
    }


# ---------------------------------------------------------------------------
# Snapshot reader helpers
# ---------------------------------------------------------------------------

def _latest_snapshot_vo2max(db, days: int = 30) -> tuple[float | None, str | None]:
    """Return (vo2max_score, date) of the most recent snapshot within `days` days."""
    rows = db._conn.execute(
        """SELECT date, value FROM ability_snapshot
           WHERE level = 'L3' AND dimension = 'vo2max'
             AND date >= date('now', ?)
           ORDER BY date DESC LIMIT 1""",
        (f"-{days} days",),
    ).fetchall()
    if not rows:
        return None, None
    r = rows[0]
    return r["value"], r["date"]


def _vo2max_trend(db) -> str:
    """Compare mean VO2max score in the last 30 days vs the prior 30-day window.

    Returns 'up', 'down', or 'flat' (±1 score point threshold).
    """
    recent = db._conn.execute(
        """SELECT AVG(value) FROM ability_snapshot
           WHERE level = 'L3' AND dimension = 'vo2max'
             AND date >= date('now', '-30 days')""",
    ).fetchone()[0]
    prior = db._conn.execute(
        """SELECT AVG(value) FROM ability_snapshot
           WHERE level = 'L3' AND dimension = 'vo2max'
             AND date >= date('now', '-60 days')
             AND date <  date('now', '-30 days')""",
    ).fetchone()[0]
    if recent is None or prior is None:
        return "flat"
    diff = recent - prior
    if diff > 1.0:
        return "up"
    if diff < -1.0:
        return "down"
    return "flat"


def _model_version_for_date(db, date: str) -> float | None:
    row = db._conn.execute(
        """SELECT value FROM ability_snapshot
           WHERE level = 'meta' AND dimension = 'model_version' AND date = ?""",
        (date,),
    ).fetchone()
    return row["value"] if row else None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/api/{user}/race-predictions")
def get_race_predictions(user: str) -> dict:
    """Current race predictions derived from the latest ability_snapshot VO2max.

    Data source: L3 vo2max dimension in ability_snapshot.  VDOT is recovered
    by inverting the scoring formula, then fed into Daniels distance tables /
    numerical solver for 5K and 10K.

    Raises 404 when no ability_snapshot rows exist for the user.
    """
    db = get_db(user)
    try:
        score, snap_date = _latest_snapshot_vo2max(db, days=90)
        if score is None:
            raise HTTPException(status_code=404, detail="No ability snapshot found for user")

        vdot = _vdot_from_score(score)
        trend = _vo2max_trend(db)
        computed_at = snap_date
    finally:
        db.close()

    distances = _predictions_from_vdot(vdot)
    goal = _read_training_goal(user)
    target_gap = _build_target_gap(goal, distances)

    return {
        "user_id": user,
        "computed_at": computed_at,
        "vo2max": round(vdot, 1),
        "vo2max_trend": trend,
        "distances": distances,
        "target_gap": target_gap,
    }


@router.get("/api/{user}/race-predictions/history")
def get_race_predictions_history(
    user: str,
    days: int = Query(180, ge=1, le=365),
) -> dict:
    """Historical race predictions for each day that has an ability_snapshot.

    Series are sorted oldest-first within each distance key.  Days missing
    from the snapshot table are absent from the output (no synthesis).
    Only rows stamped with the current ABILITY_MODEL_VERSION are included so
    stale pre-migration rows do not pollute the series.
    """
    db = get_db(user)
    try:
        rows = db._conn.execute(
            """SELECT date, value FROM ability_snapshot
               WHERE level = 'L3' AND dimension = 'vo2max'
                 AND date >= date('now', ?)
               ORDER BY date ASC""",
            (f"-{days} days",),
        ).fetchall()

        # Filter to versioned snapshots only.
        versioned_dates: set[str] = set()
        ver_rows = db._conn.execute(
            """SELECT date, value FROM ability_snapshot
               WHERE level = 'meta' AND dimension = 'model_version'
                 AND date >= date('now', ?)""",
            (f"-{days} days",),
        ).fetchall()
        for vr in ver_rows:
            if vr["value"] == ABILITY_MODEL_VERSION:
                versioned_dates.add(str(vr["date"]))
    finally:
        db.close()

    series: dict[str, list[dict]] = {k: [] for k in _DIST_M}

    for r in rows:
        date_str = str(r["date"])
        if date_str not in versioned_dates:
            continue
        score = r["value"]
        if score is None:
            continue
        vdot = _vdot_from_score(score)
        for label, dist_m in _DIST_M.items():
            t = _daniels_race_time_s(dist_m, vdot)
            if t > 0:
                series[label].append({
                    "date": date_str,
                    "predicted_time_sec": int(round(t)),
                })

    return {
        "user_id": user,
        "days": days,
        "series": series,
    }
