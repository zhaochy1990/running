"""Bounded SQLite readers for the Coach's vendor-neutral metric surface.

The watch tables intentionally retain provider pass-through fields for legacy
product surfaces.  Coach must not see those derived fields: it receives raw
measurements (RHR/HRV) plus STRIDE-computed training load and ability data.
Keeping the whitelist here makes that boundary explicit at the storage layer.
"""

from __future__ import annotations

from typing import Any

from stride_core.timefmt import sqlite_mixed_date_expr
from stride_core.training_load import TRAINING_LOAD_MODEL_VERSION

from .database import Database, HRV_PREFERRED_PER_DATE_SQL


def coach_metric_provenance(
    *, include_raw_measurements: bool = True, include_ability: bool = False
) -> dict[str, Any]:
    """Describe the only computed metric sources exposed to Coach tools."""
    result: dict[str, Any] = {
        "training_load": {
            "source": "stride",
            "kind": "computed",
            "model": "objective_training_load",
            "scale": "tss_like",
            "vendor_derived": False,
            "fields": [
                "training_dose",
                "cardio_tss",
                "external_tss",
                "mechanical_load",
                "acute_load",
                "chronic_load",
                "form",
                "load_ratio",
            ],
        }
    }
    if include_raw_measurements:
        result["raw_measurements"] = {
            "source": "watch_raw",
            "kind": "measurement",
            "vendor_derived": False,
            "fields": ["rhr", "hrv", "heart_rate", "pace", "distance", "duration"],
        }
    if include_ability:
        result["ability"] = {
            "source": "stride",
            "kind": "computed",
            "model": "ability",
            "vendor_derived": False,
        }
    return result


def fetch_recent_activities(db: Database, *, limit: int) -> list[Any]:
    """Return raw activity facts plus STRIDE per-activity training load.

    The join intentionally has no fallback to ``activities.training_load``.
    Missing STRIDE load stays missing instead of silently using a watch score.
    """
    return db.query(
        """SELECT a.label_id, a.name, a.sport_type, a.sport_name, a.date,
            a.distance_m, a.duration_s, a.avg_pace_s_km, a.avg_hr, a.max_hr,
            a.avg_cadence, a.feel_type, a.sport_note,
            atl.session_class AS stride_session_class,
            atl.algorithm_version AS stride_algorithm_version,
            atl.calibration_id AS stride_calibration_id,
            atl.cardio_load_raw AS stride_cardio_load_raw,
            atl.cardio_tss AS stride_cardio_tss,
            atl.external_tss AS stride_external_tss,
            atl.mechanical_load AS stride_mechanical_load,
            atl.subjective_internal_load AS stride_subjective_internal_load,
            atl.training_dose AS stride_training_dose,
            atl.load_confidence AS stride_load_confidence,
            atl.excluded_from_pmc AS stride_excluded_from_pmc,
            atl.reasons_json AS stride_reasons_json
        FROM activities a
        LEFT JOIN activity_training_load atl ON atl.label_id = a.label_id
          AND atl.algorithm_version = ?
        ORDER BY a.date DESC, a.label_id DESC
        LIMIT ?""",
        (TRAINING_LOAD_MODEL_VERSION, max(1, int(limit))),
    )


def fetch_latest_health_context(db: Database) -> dict[str, Any]:
    """Return STRIDE load plus raw recovery measurements for Coach."""
    load_row = db.fetch_latest_daily_training_load(
        algorithm_version=TRAINING_LOAD_MODEL_VERSION
    )
    load_fields = (
        "date",
        "algorithm_version",
        "calibration_id",
        "training_dose",
        "acute_load",
        "chronic_load",
        "form",
        "load_ratio",
        "coverage_status",
    )
    rhr_day_sql = sqlite_mixed_date_expr("date")
    rhr_rows = db.query(
        "SELECT date, rhr FROM daily_health WHERE rhr IS NOT NULL "
        f"ORDER BY {rhr_day_sql} DESC LIMIT 1"
    )
    hrv_day_sql = sqlite_mixed_date_expr("date")
    hrv_rows = db.query(
        "SELECT date, last_night_avg "
        f"FROM ({HRV_PREFERRED_PER_DATE_SQL}) "
        f"WHERE last_night_avg IS NOT NULL ORDER BY {hrv_day_sql} DESC LIMIT 1"
    )
    return {
        "load": (
            {field: load_row[field] for field in load_fields}
            if load_row is not None
            else None
        ),
        "rhr": dict(rhr_rows[0]) if rhr_rows else None,
        "hrv": dict(hrv_rows[0]) if hrv_rows else None,
    }


def fetch_health_series_context(db: Database, *, limit: int) -> dict[str, list[Any]]:
    """Return bounded source rows used to assemble Coach health trends.

    Deliberately excluded: ``fatigue``, ``ati``, ``cti``,
    ``training_load_ratio``, ``training_load_state``, provider HRV status and
    provider readiness/recovery scores.
    """
    bounded = max(1, min(int(limit), 365))
    health_day_sql = sqlite_mixed_date_expr("date")
    health_rows = db.query(
        f"""SELECT date, rhr, {health_day_sql} AS normalized_date
        FROM daily_health
        ORDER BY normalized_date DESC
        LIMIT ?""",
        (bounded,),
    )
    hrv_day_sql = sqlite_mixed_date_expr("date")
    hrv_rows = db.query(
        f"""SELECT date, last_night_avg, last_night_5min_high, {hrv_day_sql} AS normalized_date
        FROM ({HRV_PREFERRED_PER_DATE_SQL})
        WHERE last_night_avg IS NOT NULL
        ORDER BY normalized_date DESC
        LIMIT ?""",
        (bounded,),
    )
    load_rows = db.query(
        """SELECT date, algorithm_version, calibration_id, training_dose,
            acute_load, chronic_load, form, load_ratio, coverage_status
        FROM daily_training_load
        WHERE algorithm_version = ?
          AND coverage_status IN ('complete', 'partial', 'rest_confirmed')
        ORDER BY date DESC
        LIMIT ?""",
        (TRAINING_LOAD_MODEL_VERSION, bounded),
    )
    return {
        "health": health_rows,
        "hrv": hrv_rows,
        "load": load_rows,
    }


def fetch_stride_pmc_series(db: Database, *, limit: int) -> list[Any]:
    """Return only STRIDE daily load; never vendor ATI/CTI/fatigue."""
    return db.query(
        """SELECT date, algorithm_version, calibration_id, training_dose,
            acute_load, chronic_load, form, load_ratio, coverage_status
        FROM daily_training_load
        WHERE algorithm_version = ?
          AND coverage_status IN ('complete', 'partial', 'rest_confirmed')
        ORDER BY date DESC LIMIT ?""",
        (TRAINING_LOAD_MODEL_VERSION, max(1, int(limit))),
    )


def fetch_coach_ability_rows(db: Database, *, limit: int = 80) -> list[Any]:
    """Return STRIDE ability rows that do not depend on legacy readiness.

    L2 freshness, L3 recovery, and L4 composite/estimates currently include a
    legacy provider-derived fatigue input.  They stay persisted for backward
    compatibility but are withheld from Coach until that model is migrated.
    """
    return db.query(
        """SELECT date, level, dimension, value, evidence_activity_ids, computed_at
        FROM ability_snapshot
        WHERE level NOT IN ('L2', 'L4')
          AND NOT (level = 'L3' AND dimension = 'recovery')
        ORDER BY date DESC, level, dimension
        LIMIT ?""",
        (max(1, int(limit)),),
    )


def fetch_latest_coach_vo2max_score(db: Database) -> Any | None:
    """Return the latest STRIDE L3 VO2max score for race prediction."""
    rows = db.query(
        """SELECT date, value
        FROM ability_snapshot
        WHERE level = 'L3' AND dimension = 'vo2max'
        ORDER BY date DESC
        LIMIT 1"""
    )
    return rows[0] if rows else None
