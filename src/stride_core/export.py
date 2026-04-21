"""CSV export for activity data."""

from __future__ import annotations

import csv
import sys
from pathlib import Path

from .db import Database

ACTIVITY_COLUMNS = [
    "label_id", "name", "sport_name", "date", "distance_m", "duration_s",
    "avg_pace_s_km", "avg_hr", "max_hr", "avg_cadence", "ascent_m",
    "calories_kcal", "training_load", "vo2max", "train_type",
]


def export_activities(
    db: Database,
    from_date: str | None = None,
    to_date: str | None = None,
    output_path: str | None = None,
) -> None:
    conditions = []
    params: list[str] = []

    if from_date:
        conditions.append("date >= ?")
        params.append(from_date)
    if to_date:
        conditions.append("date <= ?")
        params.append(to_date)

    where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
    cols = ", ".join(ACTIVITY_COLUMNS)
    rows = db.query(f"SELECT {cols} FROM activities{where} ORDER BY date", tuple(params))

    if output_path:
        f = open(output_path, "w", newline="", encoding="utf-8")
    else:
        f = sys.stdout

    try:
        writer = csv.DictWriter(f, fieldnames=ACTIVITY_COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow(dict(row))
    finally:
        if output_path:
            f.close()
