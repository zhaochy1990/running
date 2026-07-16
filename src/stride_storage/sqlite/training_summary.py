"""Compact deterministic training summaries for Coach read tools.

All SQL stays in ``stride_storage``. The returned payload is deliberately
bounded and excludes laps/timeseries so an LLM can summarize a week without
repeatedly fetching full activity details.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date
from typing import Any

from stride_core.timefmt import SHANGHAI_DAY_SQL
from stride_core.training_load import TRAINING_LOAD_MODEL_VERSION

from .database import Database, HRV_PREFERRED_PER_DATE_SQL


_RUN_TYPES = {100, 101, 102, 103, 104, 110, 111, 112, 8001, 8002, 8003, 8004, 8005}
_RUN_NAMES = {"run", "indoor run", "trail run", "track run", "treadmill"}
_KEY_CLASSES = {"long", "tempo", "interval", "race"}


def _validate_range(date_from: str, date_to: str) -> None:
    start = date.fromisoformat(date_from)
    end = date.fromisoformat(date_to)
    if end < start:
        raise ValueError("date_to must be on or after date_from")
    if (end - start).days > 31:
        raise ValueError("training summary range cannot exceed 32 days")


def _category(row: dict[str, Any]) -> str:
    sport_type = row.get("sport_type")
    sport = str(row.get("sport") or "").lower()
    sport_name = str(row.get("sport_name") or "").lower()
    if sport_type in _RUN_TYPES or sport.startswith("run_") or sport_name in _RUN_NAMES:
        return "run"
    if sport_type in {402, 800} or sport == "strength" or "strength" in sport_name:
        return "strength"
    return "cross"


def _health_day_sql() -> str:
    return (
        "CASE WHEN length(date) = 8 THEN substr(date,1,4) || '-' || "
        "substr(date,5,2) || '-' || substr(date,7,2) ELSE substr(date,1,10) END"
    )


def get_training_summary(db: Database, *, date_from: str, date_to: str) -> dict[str, Any]:
    """Aggregate activities, load, recovery, and plan adherence.

    Bounds are inclusive Shanghai calendar dates. The maximum range is 32 days
    to keep Coach tool payloads predictably small.
    """
    _validate_range(date_from, date_to)

    activity_rows = db._conn.execute(
        f"""WITH bounded AS (
                 SELECT label_id, name, sport_type, sport_name, sport, train_kind,
                        feel, feel_type, distance_m, duration_s, avg_pace_s_km,
                        avg_hr, {SHANGHAI_DAY_SQL} AS shanghai_date
                   FROM activities
                  WHERE {SHANGHAI_DAY_SQL} BETWEEN ? AND ?
               )
               SELECT b.*, atl.session_class, atl.algorithm_version,
                      atl.calibration_id, atl.cardio_tss, atl.external_tss,
                      atl.mechanical_load, atl.training_dose, atl.load_confidence,
                      atl.excluded_from_pmc, af.rpe
                 FROM bounded b
                 LEFT JOIN activity_training_load atl ON atl.label_id = b.label_id
                   AND atl.algorithm_version = ?
                 LEFT JOIN activity_feedback af ON af.label_id = b.label_id
                ORDER BY b.shanghai_date, b.label_id""",
        (date_from, date_to, TRAINING_LOAD_MODEL_VERSION),
    ).fetchall()

    running = db.get_running_week_summaries([(0, date_from, date_to)]).get(0, {})
    activities: list[dict[str, Any]] = []
    actual_counts: dict[str, Counter[str]] = defaultdict(Counter)
    class_counts: Counter[str] = Counter()
    rpes: list[float] = []
    for raw in activity_rows:
        row = dict(raw)
        category = _category(row)
        actual_counts[row["shanghai_date"]][category] += 1
        session_class = str(row.get("session_class") or row.get("train_kind") or "unknown")
        class_counts[session_class] += 1
        if row.get("rpe") is not None:
            rpes.append(float(row["rpe"]))
        activities.append(
            {
                "label_id": row["label_id"],
                "date": row["shanghai_date"],
                "name": row.get("name") or "",
                "category": category,
                "session_class": session_class,
                "distance_km": round(float(row.get("distance_m") or 0) / 1000.0, 2),
                "duration_s": round(float(row.get("duration_s") or 0)),
                "avg_pace_s_km": row.get("avg_pace_s_km"),
                "avg_hr": row.get("avg_hr"),
                "stride_training_load": {
                    "source": "stride",
                    "vendor_derived": False,
                    "available": row.get("algorithm_version") is not None,
                    "algorithm_version": row.get("algorithm_version"),
                    "calibration_id": row.get("calibration_id"),
                    "cardio_tss": row.get("cardio_tss"),
                    "external_tss": row.get("external_tss"),
                    "mechanical_load": row.get("mechanical_load"),
                    "training_dose": row.get("training_dose"),
                    "load_confidence": row.get("load_confidence"),
                    "excluded_from_pmc": (
                        bool(row["excluded_from_pmc"])
                        if row.get("excluded_from_pmc") is not None
                        else None
                    ),
                    "missing_reason": (
                        None
                        if row.get("algorithm_version") is not None
                        else "stride_load_not_computed"
                    ),
                },
                "rpe": row.get("rpe"),
                "feel": row.get("feel") or row.get("feel_type"),
            }
        )

    planned_rows = db._conn.execute(
        """SELECT date, session_index, kind, summary, total_distance_m, total_duration_s
             FROM planned_session
            WHERE date BETWEEN ? AND ?
            ORDER BY date, session_index""",
        (date_from, date_to),
    ).fetchall()
    actionable = [row for row in planned_rows if row["kind"] not in {"rest", "note"}]
    available = {day: Counter(counts) for day, counts in actual_counts.items()}
    completed = 0
    planned_distance_m = 0.0
    for row in actionable:
        planned_distance_m += float(row["total_distance_m"] or 0)
        expected = row["kind"] if row["kind"] in {"run", "strength"} else "cross"
        if available.get(row["date"], Counter())[expected] > 0:
            available[row["date"]][expected] -= 1
            completed += 1

    all_load_rows = db.fetch_daily_training_load(
        date_from, date_to, algorithm_version=TRAINING_LOAD_MODEL_VERSION
    )
    load_rows = [
        row for row in all_load_rows
        if row["coverage_status"] in {"complete", "partial", "rest_confirmed"}
    ]
    training_dose_coverage = (
        "partial"
        if load_rows and any(
            row["coverage_status"] in {"partial", "unknown"}
            for row in all_load_rows
        )
        else "complete"
        if load_rows
        else "unknown"
    )

    day_sql = _health_day_sql()
    health_rows = db._conn.execute(
        f"""SELECT {day_sql} AS day, rhr
               FROM daily_health
              WHERE {day_sql} BETWEEN ? AND ?
              ORDER BY day""",
        (date_from, date_to),
    ).fetchall()
    hrv_rows = db._conn.execute(
        """SELECT date, last_night_avg
             FROM (""" + HRV_PREFERRED_PER_DATE_SQL + """)
            WHERE date BETWEEN ? AND ?
            ORDER BY date""",
        (date_from, date_to),
    ).fetchall()
    recovery_by_day = {row["day"]: dict(row) for row in health_rows}
    for row in hrv_rows:
        recovery_by_day.setdefault(row["date"], {"day": row["date"]}).update(
            {"hrv": row["last_night_avg"]}
        )

    key_sessions = [item for item in activities if item["session_class"] in _KEY_CLASSES]
    key_sessions.sort(
        key=lambda item: (
            float((item.get("stride_training_load") or {}).get("training_dose") or 0),
            item["duration_s"],
        ),
        reverse=True,
    )
    load_series = [
        {
            **dict(row),
            "source": "stride",
            "vendor_derived": False,
        }
        for row in load_rows
    ]
    return {
        "date_from": date_from,
        "date_to": date_to,
        "summary": {
            "activity_count": len(activities),
            "run_count": int(running.get("run_count", 0)),
            "strength_count": sum(1 for item in activities if item["category"] == "strength"),
            "run_distance_km": float(running.get("actual_distance_km", 0.0)),
            "run_duration_s": int(running.get("total_duration_s", 0)),
            "avg_pace_s_km": running.get("avg_pace_s_km"),
            "avg_hr": running.get("avg_hr"),
            "training_dose": round(sum(float(row["training_dose"] or 0) for row in load_rows), 1),
            "training_dose_coverage": training_dose_coverage,
            "avg_rpe": round(sum(rpes) / len(rpes), 1) if rpes else None,
            "session_class_counts": dict(sorted(class_counts.items())),
        },
        "plan_adherence": {
            "planned_sessions": len(actionable),
            "completed_sessions": completed,
            "completion_rate": round(completed / len(actionable), 3) if actionable else None,
            "planned_distance_km": round(planned_distance_m / 1000.0, 2),
        },
        "load_series": load_series,
        "recovery_series": [recovery_by_day[key] for key in sorted(recovery_by_day)],
        "key_sessions": key_sessions[:5],
        "activities": activities,
    }
