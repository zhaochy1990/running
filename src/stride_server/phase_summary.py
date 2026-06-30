"""Deterministic "actual results" rollup for a completed master-plan phase (Q2a).

``aggregate_phase_summary`` reads ``coros.db`` and produces a
:class:`~stride_core.master_plan.CompletedPhaseSummary` over a phase's
Shanghai-day window — total running km, run count, weekly average, duration-
weighted average pace / HR, and the HR-zone time distribution. No LLM.

This module lives in the ``stride_server`` (adapter) layer because the
aggregation touches the per-user SQLite DB; the pydantic result models stay in
``stride_core.master_plan`` (no DB dependency). The caller (S1 generation)
invokes this once per ``is_completed`` phase and caches the result on
``Phase.summary`` — reads never recompute it.

Distance / timezone discipline (CLAUDE.md HARD rules):
  * ``activities.distance_m`` actually stores KILOMETERS, so ``SUM(distance_m)``
    is already total km — never divide by 1000.
  * The window is matched on Shanghai-local days via
    :data:`stride_core.timefmt.SHANGHAI_DAY_SQL`, never a bare UTC compare.
"""

from __future__ import annotations

import math
from typing import Any

from stride_core.master_plan import CompletedPhaseSummary, HrZoneShare
from stride_core.models import RUN_SPORT_SQL_LIST
from stride_core.timefmt import SHANGHAI_DAY_SQL

# Inclusive Shanghai-day window predicate against activities.date (UTC ISO).
# ``SHANGHAI_DAY_SQL`` references a bare ``date`` column, so it is used as-is
# where ``activities`` is unaliased; the zone JOIN below qualifies its own copy.
_WINDOW_SQL = f"{SHANGHAI_DAY_SQL} BETWEEN ? AND ?"
_WINDOW_SQL_A = "date(datetime(a.date, '+8 hours')) BETWEEN ? AND ?"

# Running sport types only — excludes Strength Training (402, distance=0).
_RUN_FILTER_SQL = f"sport_type IN ({RUN_SPORT_SQL_LIST})"
_RUN_FILTER_SQL_A = f"a.sport_type IN ({RUN_SPORT_SQL_LIST})"


def _phase_weeks(start_date: str, end_date: str) -> int:
    """Number of weeks the phase spans = ceil((end - start + 1 day) / 7).

    Inclusive of both endpoints, so a Mon→Sun block is exactly 1 week and an
    8-week block (56 days) is 8. Returns 1 as a floor so weekly_avg never
    divides by zero on a malformed / single-day window.
    """
    from datetime import date as _date

    try:
        start = _date.fromisoformat(start_date)
        end = _date.fromisoformat(end_date)
    except (TypeError, ValueError):
        return 1
    days = (end - start).days + 1
    if days <= 0:
        return 1
    return max(1, math.ceil(days / 7))


def _fmt_pace(s_per_km: int | None) -> str:
    """``"M:SS"`` (no ``/km`` suffix) for a seconds-per-km value; ``""`` if None."""
    if not s_per_km or s_per_km <= 0:
        return ""
    m, sec = divmod(int(s_per_km), 60)
    return f"{m}:{sec:02d}"


def aggregate_phase_summary(
    db: Any, start_date: str, end_date: str
) -> CompletedPhaseSummary:
    """Aggregate a completed phase's actual running results from ``coros.db``.

    Args:
        db: A ``stride_storage.sqlite.database.Database`` (per-user). Only ``db.query`` is used.
        start_date / end_date: Inclusive Shanghai-local ``YYYY-MM-DD`` bounds
            (the phase's ``start_date`` / ``end_date``).

    Returns:
        A :class:`CompletedPhaseSummary`. An empty window yields zeros / None /
        empty distribution rather than raising.
    """
    window = (start_date, end_date)

    # --- distance / run count / duration-weighted pace + HR -----------------
    # Pace and HR are duration-weighted (SUM(x*duration_s)/SUM(duration_s)) and
    # only over rows that carry that metric AND a positive duration, so a
    # missing-pace or zero-duration row never skews the weighted mean.
    agg_rows = db.query(
        f"""
        SELECT
            COALESCE(SUM(distance_m), 0.0) AS total_km,
            COUNT(*) AS run_count,
            SUM(CASE WHEN avg_pace_s_km IS NOT NULL AND duration_s > 0
                     THEN avg_pace_s_km * duration_s ELSE 0 END) AS pace_wsum,
            SUM(CASE WHEN avg_pace_s_km IS NOT NULL AND duration_s > 0
                     THEN duration_s ELSE 0 END) AS pace_wden,
            SUM(CASE WHEN avg_hr IS NOT NULL AND duration_s > 0
                     THEN avg_hr * duration_s ELSE 0 END) AS hr_wsum,
            SUM(CASE WHEN avg_hr IS NOT NULL AND duration_s > 0
                     THEN duration_s ELSE 0 END) AS hr_wden
        FROM activities
        WHERE {_RUN_FILTER_SQL} AND {_WINDOW_SQL}
        """,
        window,
    )
    row = dict(agg_rows[0]) if agg_rows else {}

    total_km = round(float(row.get("total_km") or 0.0), 1)
    run_count = int(row.get("run_count") or 0)
    weeks = _phase_weeks(start_date, end_date)
    weekly_avg_km = round(total_km / weeks, 1)

    pace_wden = row.get("pace_wden") or 0
    avg_pace_s_km: int | None = (
        round(row["pace_wsum"] / pace_wden) if pace_wden else None
    )

    hr_wden = row.get("hr_wden") or 0
    avg_hr: int | None = round(row["hr_wsum"] / hr_wden) if hr_wden else None

    # --- HR zone distribution -----------------------------------------------
    # JOIN zones (heartRate type only — 'pace' rows must be excluded) to the
    # in-window running activities by label_id, group by zone_index. percent is
    # each zone's share of the phase's total in-zone time (recomputed here, not
    # the per-activity `zones.percent`, which is per-activity).
    zone_rows = db.query(
        f"""
        SELECT z.zone_index AS zone_index,
               COALESCE(SUM(z.duration_s), 0) AS total_s
        FROM zones z
        JOIN activities a ON a.label_id = z.label_id
        WHERE z.zone_type = 'heartRate'
          AND {_RUN_FILTER_SQL_A}
          AND {_WINDOW_SQL_A}
        GROUP BY z.zone_index
        ORDER BY z.zone_index
        """,
        window,
    )
    zone_dicts = [dict(r) for r in zone_rows]
    total_zone_s = sum(float(z.get("total_s") or 0) for z in zone_dicts)

    hr_zone_distribution: list[HrZoneShare] = []
    if total_zone_s > 0:
        for z in zone_dicts:
            secs = float(z.get("total_s") or 0)
            if secs <= 0:
                continue
            hr_zone_distribution.append(
                HrZoneShare(
                    zone_index=int(z["zone_index"]),
                    minutes=round(secs / 60.0),
                    percent=round(secs / total_zone_s * 100.0, 1),
                )
            )

    return CompletedPhaseSummary(
        total_distance_km=total_km,
        run_count=run_count,
        weekly_avg_km=weekly_avg_km,
        avg_pace_s_km=avg_pace_s_km,
        avg_pace_fmt=_fmt_pace(avg_pace_s_km),
        avg_hr=avg_hr,
        hr_zone_distribution=hr_zone_distribution,
    )
