"""FastAPI backend serving training data from per-user SQLite databases."""

from __future__ import annotations

import glob
import os
from pathlib import Path

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from .db import Database, USER_DATA_DIR
from .models import pace_str

app = FastAPI(title="STRIDE - Running Dashboard API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _get_db(user: str) -> Database:
    return Database(user=user)


def _get_logs_dir(user: str) -> Path:
    return USER_DATA_DIR / user / "logs"


def _format_duration(seconds: float | None, **_) -> str:
    if not seconds:
        return "—"
    s = int(seconds)
    hrs, rem = divmod(s, 3600)
    mins, secs = divmod(rem, 60)
    return f"{hrs:02d}:{mins:02d}:{secs:02d}"


# --- Users ---


@app.get("/api/users")
def list_users():
    """List all available user profiles."""
    if not USER_DATA_DIR.exists():
        return {"users": []}
    users = sorted(d.name for d in USER_DATA_DIR.iterdir() if d.is_dir() and not d.name.startswith("."))
    return {"users": users}


# --- Activities ---


@app.get("/api/{user}/activities")
def list_activities(
    user: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    sport: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
):
    db = _get_db(user)
    conditions = []
    params: list = []

    if sport:
        conditions.append("sport_name = ?")
        params.append(sport)
    if date_from:
        conditions.append("date >= ?")
        params.append(date_from)
    if date_to:
        conditions.append("date <= ?")
        params.append(date_to)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    total = db.query(f"SELECT count(*) as cnt FROM activities {where}", tuple(params))
    total_count = total[0]["cnt"] if total else 0

    rows = db.query(
        f"""SELECT label_id, name, sport_type, sport_name, date,
            distance_m, duration_s, avg_pace_s_km, avg_hr, max_hr,
            avg_cadence, calories_kcal, training_load, vo2max, train_type,
            ascent_m, aerobic_effect, anaerobic_effect,
            temperature, humidity, feels_like, wind_speed
        FROM activities {where}
        ORDER BY date DESC, label_id DESC
        LIMIT ? OFFSET ?""",
        tuple(params + [limit, offset]),
    )
    db.close()

    activities = []
    for r in rows:
        d = dict(r)
        d["distance_km"] = round(d["distance_m"], 2) if d["distance_m"] else 0
        d["duration_fmt"] = _format_duration(d["duration_s"])
        d["pace_fmt"] = pace_str(d["avg_pace_s_km"]) or "—"
        activities.append(d)

    return {"total": total_count, "offset": offset, "limit": limit, "activities": activities}


@app.get("/api/{user}/activities/{label_id}")
def get_activity(user: str, label_id: str):
    db = _get_db(user)

    rows = db.query("SELECT * FROM activities WHERE label_id = ?", (label_id,))
    if not rows:
        db.close()
        return {"error": "Not found"}, 404

    activity = dict(rows[0])
    activity["distance_km"] = round(activity["distance_m"], 2) if activity["distance_m"] else 0
    activity["duration_fmt"] = _format_duration(activity["duration_s"])
    activity["pace_fmt"] = pace_str(activity["avg_pace_s_km"]) or "—"

    # Laps - autoKm (per-km splits)
    laps_rows = db.query(
        """SELECT lap_index, lap_type, distance_m, duration_s, avg_pace,
           adjusted_pace, avg_hr, max_hr, avg_cadence, avg_power, ascent_m, descent_m
        FROM laps WHERE label_id = ? AND lap_type = 'autoKm'
        ORDER BY lap_index""",
        (label_id,),
    )
    laps = []
    for lr in laps_rows:
        ld = dict(lr)
        ld["distance_km"] = round(ld["distance_m"], 2) if ld["distance_m"] else 0
        ld["duration_fmt"] = _format_duration(ld["duration_s"], decimals=2)
        ld["pace_fmt"] = pace_str(ld["avg_pace"]) or "—"
        laps.append(ld)

    # Segments - type2 (workout structure from COROS exerciseType)
    from .models import EXERCISE_TYPES
    seg_rows = db.query(
        """SELECT lap_index, lap_type, distance_m, duration_s, avg_pace,
           adjusted_pace, avg_hr, max_hr, avg_cadence, avg_power, ascent_m, descent_m,
           exercise_type
        FROM laps WHERE label_id = ? AND lap_type = 'type2'
        ORDER BY lap_index""",
        (label_id,),
    )
    segments = []
    for sr in seg_rows:
        sd = dict(sr)
        sd["distance_km"] = round(sd["distance_m"], 2) if sd["distance_m"] else 0
        sd["duration_fmt"] = _format_duration(sd["duration_s"], decimals=2)
        sd["pace_fmt"] = pace_str(sd["avg_pace"]) or "—"
        sd["seg_name"] = EXERCISE_TYPES.get(sd.get("exercise_type") or 0, "训练")
        segments.append(sd)

    # Zones
    zones_rows = db.query(
        """SELECT zone_type, zone_index, range_min, range_max, range_unit, duration_s, percent
        FROM zones WHERE label_id = ?
        ORDER BY zone_type, zone_index""",
        (label_id,),
    )
    zones = [dict(z) for z in zones_rows]

    # Timeseries (sampled for chart - every 10th point)
    ts_rows = db.query(
        """SELECT timestamp, distance, heart_rate, speed, adjusted_pace, cadence, altitude, power
        FROM timeseries WHERE label_id = ?
        ORDER BY rowid""",
        (label_id,),
    )
    # Sample to ~500 points max for chart performance
    all_ts = [dict(t) for t in ts_rows]
    step = max(1, len(all_ts) // 500)
    timeseries = all_ts[::step]

    db.close()

    return {
        "activity": activity,
        "laps": laps,
        "segments": segments,
        "zones": zones,
        "timeseries": timeseries,
    }


# --- Weeks (plan + activities combined) ---


def _parse_week_dates(folder_name: str) -> tuple[str, str] | None:
    """Parse folder name like '2026-04-13_04-19(赛后恢复)' into (YYYY-MM-DD, YYYY-MM-DD) date range."""
    import re
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})", folder_name)
    if not m:
        return None
    year = int(m.group(1))
    sm, sd = int(m.group(2)), int(m.group(3))
    em, ed = int(m.group(4)), int(m.group(5))
    date_from = f"{year}-{sm:02d}-{sd:02d}"
    date_to = f"{year}-{em:02d}-{ed:02d}"
    return date_from, date_to


@app.get("/api/{user}/weeks")
def list_weeks(user: str):
    """List all training weeks with plan info and activity summary."""
    db = _get_db(user)
    logs_dir = _get_logs_dir(user)
    weeks = []
    if logs_dir.exists():
        for folder in sorted(logs_dir.iterdir(), reverse=True):
            if not folder.is_dir():
                continue
            dates = _parse_week_dates(folder.name)
            if not dates:
                continue

            date_from, date_to = dates
            week: dict = {
                "folder": folder.name,
                "date_from": date_from,
                "date_to": date_to,
                "has_plan": (folder / "plan.md").exists(),
                "has_feedback": (folder / "feedback.md").exists(),
                "has_inbody": any((folder / f"inbody{ext}").exists() for ext in [".jpg", ".png", ".jpeg"]),
            }

            # Read plan title
            if week["has_plan"]:
                with open(folder / "plan.md", "r", encoding="utf-8") as f:
                    week["plan_title"] = f.readline().strip().lstrip("# ")

            # Get activity summary for this week
            rows = db.query(
                """SELECT count(*) as cnt,
                    round(coalesce(sum(distance_m), 0), 1) as total_km,
                    round(coalesce(sum(duration_s), 0), 0) as total_duration_s
                FROM activities WHERE date >= ? AND date < ?""",
                (date_from, date_to + "T99"),
            )
            summary = dict(rows[0]) if rows else {}
            week["activity_count"] = summary.get("cnt", 0)
            week["total_km"] = summary.get("total_km", 0)
            week["total_duration_s"] = summary.get("total_duration_s", 0)
            week["total_duration_fmt"] = _format_duration(summary.get("total_duration_s", 0))
            weeks.append(week)

    db.close()
    return {"weeks": weeks}


@app.get("/api/{user}/weeks/{folder}")
def get_week(user: str, folder: str):
    """Get full week data: plan content + activities list."""
    dates = _parse_week_dates(folder)
    if not dates:
        return {"error": "Invalid folder"}, 400

    date_from, date_to = dates
    result: dict = {"folder": folder, "date_from": date_from, "date_to": date_to}

    logs_dir = _get_logs_dir(user)

    # Plan content
    plan_path = logs_dir / folder / "plan.md"
    if plan_path.exists():
        with open(plan_path, "r", encoding="utf-8") as f:
            result["plan"] = f.read()

    # Feedback
    feedback_path = logs_dir / folder / "feedback.md"
    if feedback_path.exists():
        with open(feedback_path, "r", encoding="utf-8") as f:
            result["feedback"] = f.read()

    # Activities for this week
    db = _get_db(user)
    rows = db.query(
        """SELECT label_id, name, sport_type, sport_name, date,
            distance_m, duration_s, avg_pace_s_km, avg_hr, max_hr,
            avg_cadence, calories_kcal, training_load, vo2max, train_type,
            ascent_m, aerobic_effect, anaerobic_effect,
            temperature, humidity, feels_like, wind_speed
        FROM activities WHERE date >= ? AND date < ?
        ORDER BY date ASC, label_id ASC""",
        (date_from, date_to + "T99"),
    )
    activities = []
    for r in rows:
        d = dict(r)
        d["distance_km"] = round(d["distance_m"], 2) if d["distance_m"] else 0
        d["duration_fmt"] = _format_duration(d["duration_s"])
        d["pace_fmt"] = pace_str(d["avg_pace_s_km"]) or "—"
        activities.append(d)

    result["activities"] = activities

    # Weekly totals
    result["total_km"] = round(sum(a["distance_km"] for a in activities), 1)
    result["total_duration_s"] = sum(a["duration_s"] or 0 for a in activities)
    result["total_duration_fmt"] = _format_duration(result["total_duration_s"])
    result["activity_count"] = len(activities)

    db.close()
    return result


# --- Sync ---


@app.post("/api/{user}/sync")
def trigger_sync(user: str):
    """Trigger a data sync from COROS for the given user."""
    from .auth import Credentials
    from .client import CorosClient
    from .sync import run_sync

    try:
        creds = Credentials.load(user=user)
        if not creds.is_logged_in:
            return {"success": False, "error": f"用户 {user} 未登录，请先运行: coros-sync --profile {user} login"}

        with CorosClient(creds, user=user) as client, Database(user=user) as db:
            activities, health = run_sync(client, db, full=False, jobs=4)
        return {
            "success": True,
            "output": f"同步完成: {activities} 条活动, {health} 条健康记录",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# --- Dashboard / Health ---


@app.get("/api/{user}/dashboard")
def get_dashboard(user: str):
    db = _get_db(user)
    rows = db.query("SELECT * FROM dashboard WHERE id = 1")
    dashboard = dict(rows[0]) if rows else {}
    if dashboard.get("threshold_pace_s_km"):
        dashboard["threshold_pace_fmt"] = pace_str(dashboard["threshold_pace_s_km"])
    if dashboard.get("weekly_distance_m"):
        dashboard["weekly_distance_km"] = round(dashboard["weekly_distance_m"], 1)

    predictions = db.query("SELECT race_type, duration_s, avg_pace FROM race_predictions ORDER BY duration_s")
    dashboard["race_predictions"] = [
        {**dict(p), "time_fmt": _format_duration(dict(p)["duration_s"]), "pace_fmt": pace_str(dict(p)["avg_pace"])}
        for p in predictions
    ]

    db.close()
    return dashboard


@app.get("/api/{user}/health")
def get_health(user: str, days: int = Query(30, ge=1, le=365)):
    db = _get_db(user)
    rows = db.query(
        "SELECT * FROM daily_health ORDER BY date DESC LIMIT ?", (days,)
    )
    db.close()
    return {"health": [dict(r) for r in rows]}


@app.get("/api/{user}/stats")
def get_stats(user: str):
    db = _get_db(user)
    total_activities = db.get_activity_count()
    total_km = db.get_total_distance_km()
    latest_date = db.get_latest_activity_date()

    # Weekly summary (last 12 weeks)
    weeks = db.query("""
        SELECT
            strftime('%Y-W%W', date(substr(date,1,4)||'-'||substr(date,5,2)||'-'||substr(date,7,2))) as week,
            count(*) as runs,
            round(sum(distance_m), 1) as distance_km,
            round(sum(duration_s), 0) as duration_s,
            round(avg(avg_pace_s_km), 1) as avg_pace,
            round(avg(avg_hr), 0) as avg_hr
        FROM activities
        WHERE sport_type IN (100, 101, 102, 103, 104)
        GROUP BY week
        ORDER BY week DESC
        LIMIT 12
    """)
    weekly = [dict(w) for w in weeks]
    for w in weekly:
        w["duration_fmt"] = _format_duration(w["duration_s"])
        w["pace_fmt"] = pace_str(w["avg_pace"]) or "—"

    db.close()
    return {
        "total_activities": total_activities,
        "total_km": total_km,
        "latest_date": latest_date,
        "weekly": weekly,
    }
