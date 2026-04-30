"""Post-sync ability hook — shared between COROS and Garmin sync paths.

After every sync, this hook:
  1. Computes L1 quality for each newly-synced running activity.
  2. Recomputes today's full ability snapshot (L2/L3/L4 + marathon estimates).
  3. Persists everything to `ability_snapshot` so the API fast path
     (`/api/{user}/ability/current` without `?refresh=1`) returns fresh data.

Living in `stride_core` rather than a per-provider module so any future
adapter can call it without depending on a specific provider package.

All operations are wrapped in try/except — a hook failure must never break
the sync pipeline (sync rolls forward; ability is best-effort).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from stride_core.db import Database
from stride_core.models import RUN_SPORT_IDS

logger = logging.getLogger(__name__)


def run_ability_hook(db: Database, new_label_ids: list[str]) -> None:
    """Compute & persist L1 + today's full snapshot. Best-effort: never raises."""
    try:
        from stride_core.ability import (
            ABILITY_MODEL_VERSION,
            L4_WEIGHTS,
            compute_ability_snapshot,
            compute_l1_quality,
        )
    except Exception as e:  # pragma: no cover
        logger.debug("ability module unavailable: %s", e)
        return

    try:
        today_iso = (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%Y-%m-%d")
        prior_l4, prior_marathon = _fetch_latest_l4_and_marathon(db)

        for lid in new_label_ids or []:
            try:
                activity = _load_activity_for_l1(db, lid)
                if activity is None:
                    continue
                if activity.get("sport_type") not in RUN_SPORT_IDS:
                    continue
                l1 = compute_l1_quality(activity, plan_target=None)
                db.upsert_activity_ability(
                    label_id=lid,
                    l1_quality=l1.get("total"),
                    l1_breakdown=l1.get("breakdown"),
                    contribution=None,
                )
            except Exception as e:
                logger.debug("ability L1 compute failed for %s: %s", lid, e)

        snapshot = compute_ability_snapshot(db, date=today_iso)

        try:
            db.upsert_ability_snapshot(
                date=today_iso, level="meta", dimension="model_version",
                value=float(ABILITY_MODEL_VERSION),
            )
            l2 = snapshot.get("l2_freshness") or {}
            if l2.get("total") is not None:
                db.upsert_ability_snapshot(
                    date=today_iso, level="L2", dimension="total",
                    value=l2.get("total"),
                )
            for dim in L4_WEIGHTS.keys():
                d = (snapshot.get("l3_dimensions") or {}).get(dim) or {}
                db.upsert_ability_snapshot(
                    date=today_iso, level="L3", dimension=dim,
                    value=d.get("score"),
                    evidence_activity_ids=d.get("evidence"),
                )
            db.upsert_ability_snapshot(
                date=today_iso, level="L4", dimension="composite",
                value=snapshot.get("l4_composite"),
                evidence_activity_ids=snapshot.get("evidence_activity_ids"),
            )
            estimates = snapshot.get("marathon_estimates") or {}
            for dim_name, key in (
                ("marathon_training_s", "training_s"),
                ("marathon_race_s",     "race_s"),
                ("marathon_best_case_s", "best_case_s"),
            ):
                val = estimates.get(key)
                if val is not None:
                    db.upsert_ability_snapshot(
                        date=today_iso, level="L4", dimension=dim_name,
                        value=float(val),
                    )
        except Exception as e:
            logger.debug("ability snapshot persistence failed: %s", e)

        new_l4 = snapshot.get("l4_composite")
        new_marathon = snapshot.get("l4_marathon_estimate_s")
        l4_before = f"{prior_l4:.1f}" if prior_l4 is not None else "—"
        l4_after = f"{new_l4:.1f}" if new_l4 is not None else "—"
        l4_delta = _fmt_delta(prior_l4, new_l4)
        m_before = _fmt_marathon(prior_marathon)
        m_after = _fmt_marathon(new_marathon)
        m_delta = _fmt_time_delta(prior_marathon, new_marathon)
        print(
            f"ability: L4 {l4_before} -> {l4_after} ({l4_delta}) | "
            f"全马典型预测 {m_before} -> {m_after} ({m_delta})"
        )
    except Exception as e:
        logger.warning("ability hook failed: %s", e)


def _fetch_latest_l4_and_marathon(db: Database) -> tuple[float | None, int | None]:
    try:
        row_comp = db._conn.execute(
            "SELECT value FROM ability_snapshot WHERE level='L4' AND dimension='composite' "
            "ORDER BY date DESC LIMIT 1"
        ).fetchone()
        row_mar = db._conn.execute(
            "SELECT value FROM ability_snapshot "
            "WHERE level='L4' AND dimension IN ('marathon_race_s','marathon_s') "
            "ORDER BY date DESC, CASE dimension WHEN 'marathon_race_s' THEN 0 ELSE 1 END LIMIT 1"
        ).fetchone()
        comp = float(row_comp[0]) if row_comp and row_comp[0] is not None else None
        mar = int(row_mar[0]) if row_mar and row_mar[0] is not None else None
        return comp, mar
    except Exception:
        return None, None


def _load_activity_for_l1(db: Database, label_id: str) -> dict | None:
    try:
        conn = db._conn
        row = conn.execute(
            "SELECT label_id, sport_type, train_type, avg_hr, max_hr, "
            "avg_pace_s_km, distance_m, duration_s, avg_cadence "
            "FROM activities WHERE label_id = ?",
            (label_id,),
        ).fetchone()
        if not row:
            return None
        d = dict(row)
        d["laps"] = [
            dict(x) for x in conn.execute(
                "SELECT lap_index, lap_type, distance_m, duration_s, avg_pace, "
                "avg_hr, max_hr, avg_cadence, exercise_type FROM laps "
                "WHERE label_id = ? ORDER BY lap_index",
                (label_id,),
            ).fetchall()
        ]
        d["zones"] = [
            dict(x) for x in conn.execute(
                "SELECT zone_type, zone_index, range_min, range_max, "
                "range_unit, duration_s, percent FROM zones WHERE label_id = ?",
                (label_id,),
            ).fetchall()
        ]
        d["timeseries"] = [
            dict(x) for x in conn.execute(
                "SELECT heart_rate, speed, cadence FROM timeseries "
                "WHERE label_id = ? ORDER BY id LIMIT 3000",
                (label_id,),
            ).fetchall()
        ]
        return d
    except Exception:
        return None


def _fmt_marathon(total_s: float | int | None) -> str:
    if total_s is None or total_s <= 0:
        return "—"
    s = int(round(total_s))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}"


def _fmt_delta(before: float | None, after: float | None, sign: bool = True) -> str:
    if before is None or after is None:
        return "—"
    delta = after - before
    if sign:
        return f"{'+' if delta >= 0 else ''}{delta:.1f}"
    return f"{delta:.1f}"


def _fmt_time_delta(before_s: int | None, after_s: int | None) -> str:
    if before_s is None or after_s is None:
        return "—"
    delta = after_s - before_s
    neg = delta < 0
    abs_s = abs(delta)
    m, sec = divmod(abs_s, 60)
    return f"{'-' if neg else '+'}{m}:{sec:02d}"
