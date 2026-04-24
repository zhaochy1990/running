"""Custom running ability score endpoints.

Exposes the 4-layer ability model (see `.omc/plans/custom-running-ability-score.md`)
as three read-only endpoints. The headline 3-tier marathon estimate
(training/race/best_case) is the primary hook the frontend uses for the
Pattern A + B hero UI.

Fast path: pre-computed rows in `ability_snapshot` (written by the sync hook).
Fallback path: on-the-fly via `compute_ability_snapshot` when no rows exist
for today — this never persists, keeping the write path in a single owner.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from stride_core.ability import (
    BEST_CASE_BOOST_PCT,
    L4_WEIGHTS,
    RACE_DAY_BOOST_PCT,
    compute_ability_snapshot,
)

from ..deps import get_db

router = APIRouter()

# L3 dimension keys in a stable UI-friendly order.
L3_KEYS: tuple[str, ...] = ("aerobic", "lt", "vo2max", "endurance", "economy", "recovery")


# Shanghai local (UTC+8) matches the project-wide convention — never use UTC dates
# for day-bucketing. daily_health / activities are filtered on +8h elsewhere, so
# "today" here must agree.
_SHANGHAI_TZ = timezone(timedelta(hours=8))


def _today_iso() -> str:
    return datetime.now(_SHANGHAI_TZ).strftime("%Y-%m-%d")


def _parse_evidence(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(x) for x in raw]
    if isinstance(raw, str):
        try:
            v = json.loads(raw)
        except json.JSONDecodeError:
            return []
        return [str(x) for x in v] if isinstance(v, list) else []
    return []


def _pivot_snapshot_rows(rows: list[Any], date: str) -> dict | None:
    """Pivot long-form ability_snapshot rows (for a single date) into the API response shape.

    Row keys: date, level, dimension, value, evidence_activity_ids, computed_at.
    Returns None when no rows for the requested date.
    """
    day_rows = [r for r in rows if str(r["date"]) == date]
    if not day_rows:
        return None

    l3: dict[str, dict[str, Any]] = {k: {"score": None, "evidence": []} for k in L3_KEYS}
    l4_composite: float | None = None
    marathon_s: dict[str, int | None] = {
        "training_s": None,
        "race_s": None,
        "best_case_s": None,
    }
    l2_total: float | None = None
    all_evidence: list[str] = []

    for r in day_rows:
        level = r["level"]
        dim = r["dimension"]
        val = r["value"]
        ev = _parse_evidence(r["evidence_activity_ids"])
        all_evidence.extend(ev)
        if level == "L3" and dim in L3_KEYS:
            l3[dim] = {"score": val, "evidence": ev}
        elif level == "L4" and dim == "composite":
            l4_composite = val
        elif level == "L4" and dim == "marathon_training_s" and val is not None:
            marathon_s["training_s"] = int(val)
        elif level == "L4" and dim == "marathon_race_s" and val is not None:
            marathon_s["race_s"] = int(val)
        elif level == "L4" and dim == "marathon_best_case_s" and val is not None:
            marathon_s["best_case_s"] = int(val)
        elif level == "L2" and dim == "total":
            l2_total = val

    race_s = marathon_s["race_s"]
    return {
        "date": date,
        "source": "snapshot",
        "l2_freshness": {"total": l2_total} if l2_total is not None else None,
        "l3_dimensions": l3,
        "l4_composite": l4_composite,
        "l4_marathon_estimate_s": race_s,
        "distance_to_sub_2_50_s": (race_s - 10200) if race_s is not None else None,
        "marathon_estimates": {
            **marathon_s,
            "race_day_boost_pct": RACE_DAY_BOOST_PCT,
            "best_case_boost_pct": BEST_CASE_BOOST_PCT,
        },
        "evidence_activity_ids": list(dict.fromkeys(all_evidence)),
    }


def _normalize_live_snapshot(snap: dict) -> dict:
    """Tag a freshly-computed snapshot as the fallback source. Shape already matches."""
    out = dict(snap)
    out["source"] = "computed"
    return out


@router.get("/api/{user}/ability/current")
def get_ability_current(user: str) -> dict:
    """Today's ability snapshot — always live-compute.

    The snapshot table intentionally stores only top-level scalars (scores),
    which loses the VO2max estimator breakdown (primary/secondary/floor VDOT)
    that the detail UI needs. Computing on-demand is the single source of
    truth and still cheap enough for a page load (~200ms).
    The /history endpoint remains snapshot-backed for trend charts.
    """
    db = get_db(user)
    today = _today_iso()
    try:
        snap = compute_ability_snapshot(db, today)
    finally:
        db.close()
    return _normalize_live_snapshot(snap)


@router.get("/api/{user}/ability/history")
def get_ability_history(
    user: str,
    days: int = Query(90, ge=1, le=365),
) -> list[dict]:
    """Pivoted per-day history over the last `days` days, sorted oldest-first.

    Each item: `{date, l4_composite, l4_marathon_race_s, l3: {aerobic, lt, ...}}`.
    Days missing in the snapshot table are simply absent from the output (no
    synthesis — we report exactly what has been persisted).
    """
    db = get_db(user)
    try:
        rows = list(db.fetch_ability_history(days=days))
    finally:
        db.close()

    # Bucket rows by date.
    by_date: dict[str, list[Any]] = {}
    for r in rows:
        by_date.setdefault(str(r["date"]), []).append(r)

    out: list[dict] = []
    for date in sorted(by_date.keys()):  # oldest first
        l3_scores: dict[str, float | None] = {k: None for k in L3_KEYS}
        l4_composite: float | None = None
        race_s: int | None = None
        for r in by_date[date]:
            level, dim, val = r["level"], r["dimension"], r["value"]
            if level == "L3" and dim in L3_KEYS:
                l3_scores[dim] = val
            elif level == "L4" and dim == "composite":
                l4_composite = val
            elif level == "L4" and dim == "marathon_race_s" and val is not None:
                race_s = int(val)
        out.append({
            "date": date,
            "l4_composite": l4_composite,
            "l4_marathon_race_s": race_s,
            "l3": l3_scores,
        })
    return out


@router.get("/api/{user}/activities/{label_id}/ability")
def get_activity_ability(user: str, label_id: str) -> dict:
    """L1 quality + breakdown + contribution for a single activity.

    404 when no row exists — contribution/L1 are produced by the sync hook
    after the activity first lands, so a missing row means the new-activity
    pipeline hasn't computed it yet.
    """
    db = get_db(user)
    try:
        row = db.fetch_activity_ability(label_id)
    finally:
        db.close()

    if row is None:
        raise HTTPException(status_code=404, detail="ability not computed for activity")

    def _loads(s: Any) -> dict:
        if not s:
            return {}
        if isinstance(s, dict):
            return s
        try:
            v = json.loads(s)
        except json.JSONDecodeError:
            return {}
        return v if isinstance(v, dict) else {}

    return {
        "label_id": row["label_id"],
        "l1_quality": row["l1_quality"],
        "l1_breakdown": _loads(row["l1_breakdown"]),
        "contribution": _loads(row["contribution"]),
        "computed_at": row["computed_at"],
    }


# Expose L4 weights so the frontend can render the weighting explanation without
# duplicating constants.
@router.get("/api/{user}/ability/weights")
def get_ability_weights(user: str) -> dict:
    return {"l4_weights": dict(L4_WEIGHTS)}
