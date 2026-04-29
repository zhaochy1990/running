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
import logging
from datetime import datetime, timezone, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from stride_core.ability import (
    ABILITY_MODEL_VERSION,
    BEST_CASE_BOOST_MAX,
    L4_WEIGHTS,
    RACE_DAY_BOOST_MAX,
    _scaled_boost,
    compute_ability_snapshot,
    marathon_target_from_profile,
    marathon_target_label,
)
from stride_core.db import USER_DATA_DIR

from ..deps import get_db

router = APIRouter()
logger = logging.getLogger(__name__)

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


def _load_profile(user: str) -> dict[str, Any] | None:
    path = USER_DATA_DIR / user / "profile.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("ability: cannot read profile for %s: %s", user, exc)
        return None
    if not isinstance(data, dict):
        logger.warning("ability: profile for %s is not a JSON object", user)
        return None
    return data


def _target_payload(user: str, race_s: int | float | None) -> dict[str, Any]:
    target_s = marathon_target_from_profile(_load_profile(user))
    return {
        "marathon_target_s": target_s,
        "marathon_target_label": marathon_target_label(target_s) if target_s is not None else None,
        "distance_to_target_s": (
            float(race_s) - target_s
            if race_s is not None and target_s is not None
            else None
        ),
    }


def _attach_target(user: str, snapshot: dict[str, Any]) -> dict[str, Any]:
    race_s = snapshot.get("l4_marathon_estimate_s")
    if race_s is None:
        race_s = (snapshot.get("marathon_estimates") or {}).get("race_s")
    return {**snapshot, **_target_payload(user, race_s)}


def _pivot_snapshot_rows(rows: list[Any], date: str) -> dict | None:
    """Pivot long-form ability_snapshot rows (for a single date) into the API response shape.

    Row keys: date, level, dimension, value, evidence_activity_ids, computed_at.
    Returns None when no rows for the requested date.
    """
    day_rows = [r for r in rows if str(r["date"]) == date]
    if not day_rows:
        return None
    version = next(
        (
            r["value"] for r in day_rows
            if r["level"] == "meta" and r["dimension"] == "model_version"
        ),
        None,
    )
    if version != ABILITY_MODEL_VERSION:
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
        "model_version": ABILITY_MODEL_VERSION,
        "date": date,
        "source": "snapshot",
        "l2_freshness": {"total": l2_total} if l2_total is not None else None,
        "l3_dimensions": l3,
        "l4_composite": l4_composite,
        "l4_marathon_estimate_s": race_s,
        "distance_to_sub_2_50_s": (race_s - 10200) if race_s is not None else None,
        "marathon_estimates": {
            **marathon_s,
            "race_day_boost_max": RACE_DAY_BOOST_MAX,
            "best_case_boost_max": BEST_CASE_BOOST_MAX,
            "race_day_boost_applied": (
                round(_scaled_boost(float(marathon_s["training_s"]), RACE_DAY_BOOST_MAX), 4)
                if marathon_s["training_s"] else 0.0
            ),
            "best_case_boost_applied": (
                round(_scaled_boost(float(marathon_s["training_s"]), BEST_CASE_BOOST_MAX), 4)
                if marathon_s["training_s"] else 0.0
            ),
        },
        "evidence_activity_ids": list(dict.fromkeys(all_evidence)),
    }


def _normalize_live_snapshot(snap: dict) -> dict:
    """Tag a freshly-computed snapshot as the fallback source. Shape already matches."""
    out = dict(snap)
    out["source"] = "computed"
    return out


@router.get("/api/{user}/ability/current")
def get_ability_current(user: str, refresh: bool = Query(False)) -> dict:
    """Today's ability snapshot — snapshot-first with live-compute fallback.

    Prod DB sits on Azure Files, where `compute_ability_snapshot` takes 10-15s
    per call. The sync hook already persists a snapshot row for each day, so
    we read that on the hot path.

    Trade-off: the snapshot table stores top-level scalars only; the VO2max
    breakdown (primary/secondary/floor VDOT) is lost. `Vo2maxPanel` gracefully
    handles the missing fields ("今日从快照读取；刷新后将显示三路径对比").
    Pass `?refresh=1` to force a live-compute when the breakdown is needed.
    """
    db = get_db(user)
    today = _today_iso()
    try:
        if not refresh:
            rows = db._conn.execute(
                """SELECT date, level, dimension, value, evidence_activity_ids, computed_at
                   FROM ability_snapshot WHERE date = ?""",
                (today,),
            ).fetchall()
            pivoted = _pivot_snapshot_rows(list(rows), today)
            if pivoted is not None:
                return _attach_target(user, pivoted)
        snap = compute_ability_snapshot(db, today)
    finally:
        db.close()
    return _attach_target(user, _normalize_live_snapshot(snap))


@router.post("/api/{user}/ability/backfill")
def post_ability_backfill(
    user: str,
    days: int = Query(180, ge=7, le=365),
) -> dict:
    """Populate `ability_snapshot` for the last `days` days on prod.

    Used to seed history from an empty table (first-time setup on a fresh
    deployment). Idempotent — re-running just re-computes the same values.
    Expensive (~200ms per day), so default is 180 days and max 365.
    """
    end = datetime.now(_SHANGHAI_TZ)
    start = end - timedelta(days=days)
    dates = [(start + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(days + 1)]

    db = get_db(user)
    wrote = 0
    skipped = 0
    try:
        for d_iso in dates:
            try:
                snap = compute_ability_snapshot(db, date=d_iso)
            except Exception:
                skipped += 1
                continue
            # Persist each dimension row.
            db.upsert_ability_snapshot(
                date=d_iso, level="meta", dimension="model_version",
                value=float(ABILITY_MODEL_VERSION),
            )
            l2 = snap.get("l2_freshness") or {}
            if l2.get("total") is not None:
                db.upsert_ability_snapshot(
                    date=d_iso, level="L2", dimension="total", value=l2.get("total"),
                )
            for dim in L4_WEIGHTS.keys():
                cell = (snap.get("l3_dimensions") or {}).get(dim) or {}
                db.upsert_ability_snapshot(
                    date=d_iso, level="L3", dimension=dim,
                    value=cell.get("score"),
                    evidence_activity_ids=cell.get("evidence"),
                )
            db.upsert_ability_snapshot(
                date=d_iso, level="L4", dimension="composite",
                value=snap.get("l4_composite"),
                evidence_activity_ids=snap.get("evidence_activity_ids"),
            )
            estimates = snap.get("marathon_estimates") or {}
            for dim_name, key in (
                ("marathon_training_s", "training_s"),
                ("marathon_race_s",     "race_s"),
                ("marathon_best_case_s", "best_case_s"),
            ):
                val = estimates.get(key)
                if val is not None:
                    db.upsert_ability_snapshot(
                        date=d_iso, level="L4", dimension=dim_name,
                        value=float(val),
                    )
            wrote += 1
    finally:
        db.close()
    return {"days_requested": days, "written": wrote, "skipped": skipped}


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
        version = next(
            (
                r["value"] for r in by_date[date]
                if r["level"] == "meta" and r["dimension"] == "model_version"
            ),
            None,
        )
        if version != ABILITY_MODEL_VERSION:
            continue
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
