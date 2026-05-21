"""STRIDE self-developed metric endpoints — /api/{user}/stride/*.

These endpoints expose STRIDE-algorithm-computed values (calibration
thresholds, training zones, daily training load) explicitly separate
from watch-passthrough fields served by /api/{user}/health and /hrv.

Owns: running_calibration_snapshot, running_calibration_zone,
      daily_training_load.
Strictly avoids: daily_health.ati / cti / training_load_*
                 (those are COROS-reported pass-throughs).
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Query

from ..deps import get_db

router = APIRouter()


def _pace_per_km_sec(speed_mps: float | None) -> int | None:
    if not speed_mps or speed_mps <= 0:
        return None
    return int(round(1000.0 / speed_mps))


def _pace_fmt(speed_mps: float | None) -> str | None:
    """Convert speed (m/s) to 'M:SS' /km."""
    secs = _pace_per_km_sec(speed_mps)
    if secs is None:
        return None
    return f"{secs // 60}:{secs % 60:02d}"


_ZONE_LABELS = {
    "recovery":   "恢复",
    "easy":       "轻松",
    "marathon":   "马拉松",
    "threshold":  "阈值",
    "interval":   "间歇",
    "repetition": "反复",
}
_ZONE_ORDER = {
    "recovery": 0, "easy": 1, "marathon": 2,
    "threshold": 3, "interval": 4, "repetition": 5,
}


@router.get("/api/{user}/stride/zones")
def get_stride_zones(user: str) -> dict[str, Any]:
    db = get_db(user)
    try:
        snap_rows = db._conn.execute(
            """SELECT id, as_of_date, threshold_hr, threshold_speed_mps,
                      threshold_hr_confidence, threshold_speed_confidence
               FROM running_calibration_snapshot
               ORDER BY as_of_date DESC, id DESC
               LIMIT 1"""
        ).fetchall()
        if not snap_rows:
            return {"threshold": None, "pace_zones": [], "hr_zones": []}
        snap = dict(snap_rows[0])

        threshold = {
            "speed_mps": snap["threshold_speed_mps"],
            "pace_per_km_sec": _pace_per_km_sec(snap["threshold_speed_mps"]),
            "hr_bpm": snap["threshold_hr"],
            "speed_confidence": snap["threshold_speed_confidence"],
            "hr_confidence": snap["threshold_hr_confidence"],
            "as_of_date": snap["as_of_date"],
            "calibration_id": snap["id"],
        }

        zone_rows = db._conn.execute(
            """SELECT zone_kind, name, min_value, max_value,
                      min_speed_mps, max_speed_mps
               FROM running_calibration_zone
               WHERE snapshot_id = ?
               ORDER BY zone_kind, name""",
            (snap["id"],),
        ).fetchall()

        hr_zones = []
        pace_zones = []
        for row in zone_rows:
            r = dict(row)
            kind = r["zone_kind"]
            if kind in ("hr", "heart_rate"):
                hr_zones.append({
                    "name": r["name"],
                    "label": _ZONE_LABELS.get(r["name"], r["name"]),
                    "lower_bpm": int(r["min_value"]) if r["min_value"] is not None else None,
                    "upper_bpm": int(r["max_value"]) if r["max_value"] is not None else None,
                })
            elif kind == "pace":
                # Pace zone speeds: min_speed_mps = slower edge (larger pace seconds),
                # max_speed_mps = faster edge (smaller pace seconds). Display lower_pace
                # as the slower edge (so users read top-to-bottom recovery → repetition).
                pace_zones.append({
                    "name": r["name"],
                    "label": _ZONE_LABELS.get(r["name"], r["name"]),
                    "lower_pace": _pace_fmt(r["min_speed_mps"]),
                    "upper_pace": _pace_fmt(r["max_speed_mps"]),
                })
        # Physiological order: recovery → easy → marathon → threshold → interval → repetition.
        # SQL ORDER BY name only gives alphabetic which scrambles the intuitive flow.
        hr_zones.sort(key=lambda z: _ZONE_ORDER.get(z["name"], 99))
        pace_zones.sort(key=lambda z: _ZONE_ORDER.get(z["name"], 99))

        return {
            "threshold": threshold,
            "pace_zones": pace_zones,
            "hr_zones": hr_zones,
        }
    finally:
        db.close()


@router.get("/api/{user}/stride/training-load")
def get_stride_training_load(
    user: str,
    days: int = Query(90, ge=7, le=365),
) -> dict[str, Any]:
    db = get_db(user)
    try:
        rows = db._conn.execute(
            """SELECT date, algorithm_version, training_dose, acute_load,
                      chronic_load, form, load_ratio, readiness_gate,
                      readiness_reasons_json
               FROM daily_training_load
               ORDER BY date DESC
               LIMIT ?""",
            (days,),
        ).fetchall()
        if not rows:
            return {"current": None, "series": []}

        records: list[dict[str, Any]] = []
        for r in rows:
            rec = dict(r)
            reasons_raw = rec.pop("readiness_reasons_json", None)
            try:
                reasons = json.loads(reasons_raw) if reasons_raw else []
            except (TypeError, ValueError):
                reasons = []
            rec["readiness_reasons"] = reasons if isinstance(reasons, list) else []
            records.append(rec)

        records.sort(key=lambda r: r["date"])
        current = dict(records[-1])
        return {"current": current, "series": records}
    finally:
        db.close()
