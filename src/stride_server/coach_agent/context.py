"""Deterministic context loaders for the STRIDE coach agent."""

from __future__ import annotations

import json
from datetime import date
from typing import Any

from stride_core import db as core_db
from stride_core.db import Database
from stride_core.models import RUN_SPORT_SQL_LIST as _RUN_SPORT_SQL, pace_str
from stride_core.source import DataSource
from stride_core.state_stores import (
    SqliteInBodyStore,
    SqlitePlanStateStore,
)

from stride_server import content_store
from stride_server.deps import PROJECT_ROOT, format_duration, parse_week_dates
from stride_server.routes.inbody import PHASE_CHECKPOINTS
from stride_server.routes.training_plan import get_training_plan


def _row_dict(row) -> dict[str, Any]:
    return dict(row) if row is not None else {}


def _activity_payload(row) -> dict[str, Any]:
    d = dict(row)
    d["distance_km"] = round(d["distance_m"], 2) if d.get("distance_m") else 0
    d["duration_fmt"] = format_duration(d.get("duration_s"))
    d["pace_fmt"] = pace_str(d.get("avg_pace_s_km")) or "—"
    return d


def _rhr_baseline(db: Database) -> int | None:
    rows = db.query(
        "SELECT rhr FROM daily_health WHERE rhr IS NOT NULL AND rhr > 0 "
        "ORDER BY date DESC LIMIT 90"
    )
    vals = sorted(int(r["rhr"]) for r in rows)
    if len(vals) < 14:
        return None
    return vals[max(0, int(len(vals) * 0.1) - 1)]


def _tsb_zone(tsb: float) -> tuple[str, str]:
    if tsb >= 25:
        return "overtaper", "减量过多"
    if tsb >= 10:
        return "race_ready", "比赛就绪"
    if tsb >= -10:
        return "neutral", "过渡区"
    if tsb >= -30:
        return "training", "正常训练"
    return "overreaching", "过度负荷"


def load_profile(user: str) -> dict[str, Any] | None:
    path = core_db.USER_DATA_DIR / user / "profile.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def load_overall_training_plan(user: str) -> dict[str, Any]:
    plan = get_training_plan(user)
    if plan.get("content") is None:
        fallback = PROJECT_ROOT / "TRAINING_PLAN.md"
        if fallback.exists():
            plan["content"] = fallback.read_text(encoding="utf-8")
    return plan


def load_week_context(user: str, folder: str, db: Database) -> dict[str, Any]:
    dates = parse_week_dates(folder)
    if not dates:
        raise ValueError("Invalid week folder")
    date_from, date_to = dates

    plan_store = SqlitePlanStateStore(db)
    plan_source = "none"
    plan = None
    plan_row = plan_store.get_weekly_plan_row(folder)
    if plan_row is not None:
        plan = plan_row["content_md"]
        plan_source = "db"
    else:
        plan_item = content_store.read_text(f"{user}/logs/{folder}/plan.md")
        if plan_item is not None:
            plan = plan_item.content
            plan_source = plan_item.source

    feedback_source = "none"
    feedback = None
    feedback_row = plan_store.get_weekly_feedback_row(folder)
    if feedback_row is not None:
        feedback = feedback_row["content_md"]
        feedback_source = "db"
    else:
        feedback_item = content_store.read_text(f"{user}/logs/{folder}/feedback.md")
        if feedback_item is not None:
            feedback = feedback_item.content
            feedback_source = feedback_item.source

    rows = db.query(
        """SELECT label_id, name, sport_type, sport_name, date,
            distance_m, duration_s, avg_pace_s_km, avg_hr, max_hr,
            avg_cadence, calories_kcal, training_load, vo2max, train_type,
            ascent_m, aerobic_effect, anaerobic_effect,
            temperature, humidity, feels_like, wind_speed,
            feel_type, sport_note
        FROM activities WHERE date >= ? AND date < ?
        ORDER BY date ASC, label_id ASC""",
        (date_from, date_to + "T99"),
    )
    activities = [_activity_payload(r) for r in rows]

    return {
        "folder": folder,
        "date_from": date_from,
        "date_to": date_to,
        "plan": plan,
        "plan_source": plan_source,
        "feedback": feedback,
        "feedback_source": feedback_source,
        "activities": activities,
        "summary": {
            "activity_count": len(activities),
            "total_km": round(sum(a["distance_km"] for a in activities), 1),
            "total_duration_s": sum(a.get("duration_s") or 0 for a in activities),
            "total_duration_fmt": format_duration(sum(a.get("duration_s") or 0 for a in activities)),
        },
    }


def load_recent_activities(db: Database, *, limit: int = 80) -> list[dict[str, Any]]:
    rows = db.query(
        """SELECT label_id, name, sport_type, sport_name, date,
            distance_m, duration_s, avg_pace_s_km, avg_hr, max_hr,
            avg_cadence, calories_kcal, training_load, vo2max, train_type,
            ascent_m, aerobic_effect, anaerobic_effect,
            temperature, humidity, feels_like, wind_speed,
            feel_type, sport_note
        FROM activities
        ORDER BY date DESC, label_id DESC
        LIMIT ?""",
        (limit,),
    )
    return [_activity_payload(r) for r in rows]


def load_weekly_volume(db: Database, *, weeks: int = 12) -> list[dict[str, Any]]:
    rows = db.query(
        """SELECT
            strftime('%Y-W%W', date(substr(date,1,4)||'-'||substr(date,5,2)||'-'||substr(date,7,2))) as week,
            count(*) as runs,
            round(coalesce(sum(distance_m), 0), 1) as distance_km,
            round(coalesce(sum(duration_s), 0), 0) as duration_s,
            round(avg(avg_pace_s_km), 1) as avg_pace,
            round(avg(avg_hr), 0) as avg_hr,
            round(coalesce(sum(training_load), 0), 1) as training_load
        FROM activities
        WHERE sport_type IN (""" + _RUN_SPORT_SQL + """)
        GROUP BY week
        ORDER BY week DESC
        LIMIT ?""",
        (weeks,),
    )
    out = []
    for r in rows:
        d = dict(r)
        d["duration_fmt"] = format_duration(d.get("duration_s"))
        d["pace_fmt"] = pace_str(d.get("avg_pace")) or "—"
        out.append(d)
    return out


def load_health_context(db: Database, *, days: int = 120) -> dict[str, Any]:
    rows = db.query(
        "SELECT date, ati, cti, rhr, distance_m, duration_s, training_load_ratio, "
        "training_load_state, fatigue FROM daily_health ORDER BY date DESC LIMIT ?",
        (days,),
    )
    records = [dict(r) for r in rows]
    for rec in records:
        ati = rec.get("ati")
        cti = rec.get("cti")
        if ati is not None and cti is not None:
            tsb = round(cti - ati, 1)
            zone, label = _tsb_zone(tsb)
            rec["tsb"] = tsb
            rec["tsb_zone"] = zone
            rec["tsb_zone_label"] = label

    dash = db.query(
        "SELECT avg_sleep_hrv, hrv_normal_low, hrv_normal_high, recovery_pct, "
        "running_level, aerobic_score, lactate_threshold_score, threshold_hr, "
        "threshold_pace_s_km, weekly_distance_m, weekly_duration_s "
        "FROM dashboard WHERE id = 1"
    )
    dashboard = _row_dict(dash[0]) if dash else {}
    if dashboard.get("threshold_pace_s_km"):
        dashboard["threshold_pace_fmt"] = pace_str(dashboard["threshold_pace_s_km"])
    if dashboard.get("weekly_distance_m"):
        dashboard["weekly_distance_km"] = round(dashboard["weekly_distance_m"], 1)

    predictions = db.query(
        "SELECT race_type, duration_s, avg_pace FROM race_predictions ORDER BY duration_s"
    )
    race_predictions = []
    for p in predictions:
        d = dict(p)
        d["time_fmt"] = format_duration(d.get("duration_s"))
        d["pace_fmt"] = pace_str(d.get("avg_pace")) or "—"
        race_predictions.append(d)

    latest = records[0] if records else None
    return {
        "latest": latest,
        "records_desc": records,
        "rhr_baseline": _rhr_baseline(db),
        "dashboard": dashboard,
        "race_predictions": race_predictions,
    }


def load_inbody_context(db: Database) -> dict[str, Any]:
    inbody_store = SqliteInBodyStore(db)
    latest = inbody_store.latest_inbody_scan()
    if latest is None:
        return {"latest": None, "deltas": None, "checkpoints": PHASE_CHECKPOINTS}

    latest_d = dict(latest)
    latest_d["segments"] = [dict(s) for s in inbody_store.get_inbody_segments(latest_d["scan_date"])]
    prior_rows = db.query(
        "SELECT * FROM inbody_scan WHERE scan_date < ? ORDER BY scan_date DESC LIMIT 1",
        (latest_d["scan_date"],),
    )
    prior = dict(prior_rows[0]) if prior_rows else None
    deltas = None
    if prior:
        deltas = {
            "prev_date": prior["scan_date"],
            "weight_kg": round(latest_d["weight_kg"] - prior["weight_kg"], 2),
            "body_fat_pct": round(latest_d["body_fat_pct"] - prior["body_fat_pct"], 2),
            "smm_kg": round(latest_d["smm_kg"] - prior["smm_kg"], 2),
            "fat_mass_kg": round(latest_d["fat_mass_kg"] - prior["fat_mass_kg"], 2),
            "visceral_fat_level": latest_d["visceral_fat_level"] - prior["visceral_fat_level"],
        }
    return {"latest": latest_d, "deltas": deltas, "checkpoints": PHASE_CHECKPOINTS}


def load_ability_context(db: Database, *, limit: int = 80) -> dict[str, Any]:
    rows = db.query(
        """SELECT date, level, dimension, value, evidence_activity_ids, computed_at
           FROM ability_snapshot
           ORDER BY date DESC, level, dimension
           LIMIT ?""",
        (limit,),
    )
    records = [dict(r) for r in rows]
    latest_date = records[0]["date"] if records else None
    latest = [r for r in records if r["date"] == latest_date] if latest_date else []
    return {"latest_date": latest_date, "latest": latest, "records_desc": records}


def maybe_sync_user(user: str, source: DataSource | None, *, enabled: bool) -> dict[str, Any]:
    if not enabled:
        return {"attempted": False, "success": None, "message": "sync skipped by request"}
    if source is None:
        return {"attempted": False, "success": None, "message": "sync source unavailable"}
    if not source.is_logged_in(user):
        return {"attempted": True, "success": False, "message": "user is not logged in to data source"}
    result = source.sync_user(user, full=False)
    return {
        "attempted": True,
        "success": True,
        "activities": result.activities,
        "health": result.health,
        "message": f"synced {result.activities} activities and {result.health} health records",
    }


def load_coach_context(
    user: str,
    *,
    folder: str | None = None,
    source: DataSource | None = None,
    sync_before: bool = True,
    recent_limit: int = 80,
    health_days: int = 120,
) -> dict[str, Any]:
    sync = maybe_sync_user(user, source, enabled=sync_before)
    db = Database(user=user)
    try:
        selected_week = load_week_context(user, folder, db) if folder else None
        return {
            "as_of": date.today().isoformat(),
            "user": user,
            "sync": sync,
            "profile": load_profile(user),
            "training_plan": load_overall_training_plan(user),
            "selected_week": selected_week,
            "recent_activities": load_recent_activities(db, limit=recent_limit),
            "weekly_volume": load_weekly_volume(db, weeks=12),
            "health": load_health_context(db, days=health_days),
            "inbody": load_inbody_context(db),
            "ability": load_ability_context(db),
        }
    finally:
        db.close()


def summarize_context(context: dict[str, Any]) -> dict[str, Any]:
    week = context.get("selected_week") or {}
    health = context.get("health") or {}
    inbody = context.get("inbody") or {}
    ability = context.get("ability") or {}
    return {
        "sync": context.get("sync"),
        "selected_week": {
            "folder": week.get("folder"),
            "date_from": week.get("date_from"),
            "date_to": week.get("date_to"),
            "plan_source": week.get("plan_source"),
            "feedback_source": week.get("feedback_source"),
            "summary": week.get("summary"),
        } if week else None,
        "recent_activity_count": len(context.get("recent_activities") or []),
        "latest_health": health.get("latest"),
        "latest_inbody_date": (inbody.get("latest") or {}).get("scan_date"),
        "latest_ability_date": ability.get("latest_date"),
    }
