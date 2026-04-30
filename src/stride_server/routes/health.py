"""Dashboard, daily health, PMC, and rollup stats."""

from __future__ import annotations

from fastapi import APIRouter, Query

from stride_core.models import pace_str

from ..deps import format_duration, get_db

router = APIRouter()


@router.get("/api/{user}/dashboard")
def get_dashboard(user: str):
    db = get_db(user)
    rows = db.query("SELECT * FROM dashboard WHERE id = 1")
    dashboard = dict(rows[0]) if rows else {}
    if dashboard.get("threshold_pace_s_km"):
        dashboard["threshold_pace_fmt"] = pace_str(dashboard["threshold_pace_s_km"])
    if dashboard.get("weekly_distance_m"):
        dashboard["weekly_distance_km"] = round(dashboard["weekly_distance_m"], 1)

    predictions = db.query(
        "SELECT race_type, duration_s, avg_pace FROM race_predictions ORDER BY duration_s"
    )
    dashboard["race_predictions"] = [
        {
            **dict(p),
            "time_fmt": format_duration(dict(p)["duration_s"]),
            "pace_fmt": pace_str(dict(p)["avg_pace"]),
        }
        for p in predictions
    ]

    db.close()
    return dashboard


@router.get("/api/{user}/health")
def get_health(user: str, days: int = Query(30, ge=1, le=365)):
    db = get_db(user)
    rows = db.query("SELECT * FROM daily_health ORDER BY date DESC LIMIT ?", (days,))
    dash = db.query(
        "SELECT avg_sleep_hrv, hrv_normal_low, hrv_normal_high, recovery_pct "
        "FROM dashboard WHERE id = 1"
    )
    hrv = dict(dash[0]) if dash else {}

    # 10th percentile of last 90 days of RHR = "rested baseline"; None if too few samples
    rhr_rows = db.query(
        "SELECT rhr FROM daily_health WHERE rhr IS NOT NULL AND rhr > 0 "
        "ORDER BY date DESC LIMIT 90"
    )
    rhr_vals = sorted(int(r["rhr"]) for r in rhr_rows)
    if len(rhr_vals) >= 14:
        idx = max(0, int(len(rhr_vals) * 0.1) - 1)
        rhr_baseline = rhr_vals[idx]
    else:
        rhr_baseline = None

    db.close()
    return {
        "health": [dict(r) for r in rows],
        "hrv": hrv,
        "rhr_baseline": rhr_baseline,
    }


@router.get("/api/{user}/hrv")
def get_hrv(user: str, days: int = Query(30, ge=1, le=365)):
    """Per-day HRV detail (Garmin-rich; COROS users get an empty list).

    Returns the last `days` rows from `daily_hrv` ordered oldest → newest
    (chart-friendly), plus a small summary block for the latest reading.
    """
    db = get_db(user)
    rows = db.query("SELECT * FROM daily_hrv ORDER BY date DESC LIMIT ?", (days,))
    db.close()

    records = [dict(r) for r in rows]
    records.reverse()
    latest = records[-1] if records else {}

    return {
        "hrv": records,
        "summary": {
            "date": latest.get("date"),
            "last_night_avg": latest.get("last_night_avg"),
            "weekly_avg": latest.get("weekly_avg"),
            "status": latest.get("status"),
            "baseline_balanced_low": latest.get("baseline_balanced_low"),
            "baseline_balanced_upper": latest.get("baseline_balanced_upper"),
        },
    }


@router.get("/api/{user}/pmc")
def get_pmc(user: str, days: int = Query(90, ge=14, le=365)):
    """Performance Management Chart data: CTI (fitness), ATI (fatigue), TSB (form)."""
    db = get_db(user)
    rows = db.query(
        "SELECT date, ati, cti, training_load_ratio, training_load_state, fatigue, rhr "
        "FROM daily_health ORDER BY date DESC LIMIT ?",
        (days,),
    )
    db.close()

    records = [dict(r) for r in rows]
    records.reverse()

    for i, rec in enumerate(records):
        ati = rec.get("ati") or 0
        cti = rec.get("cti") or 0
        rec["tsb"] = round(cti - ati, 1)

        tsb = rec["tsb"]
        if tsb >= 25:
            rec["tsb_zone"] = "overtaper"
            rec["tsb_zone_label"] = "减量过多"
        elif tsb >= 10:
            rec["tsb_zone"] = "race_ready"
            rec["tsb_zone_label"] = "比赛就绪"
        elif tsb >= -10:
            rec["tsb_zone"] = "neutral"
            rec["tsb_zone_label"] = "过渡区"
        elif tsb >= -30:
            rec["tsb_zone"] = "training"
            rec["tsb_zone_label"] = "正常训练"
        else:
            rec["tsb_zone"] = "overreaching"
            rec["tsb_zone_label"] = "过度负荷"

        if i >= 7:
            prev_cti = records[i - 7].get("cti") or 0
            rec["ctl_ramp"] = round(cti - prev_cti, 1)
        else:
            rec["ctl_ramp"] = None

    latest = records[-1] if records else {}
    summary = {
        "current_cti": latest.get("cti"),
        "current_ati": latest.get("ati"),
        "current_tsb": latest.get("tsb"),
        "current_tsb_zone": latest.get("tsb_zone"),
        "current_tsb_zone_label": latest.get("tsb_zone_label"),
        "current_fatigue": latest.get("fatigue"),
        "current_rhr": latest.get("rhr"),
        "ctl_ramp": latest.get("ctl_ramp"),
        "date": latest.get("date"),
    }

    return {"pmc": records, "summary": summary}


@router.get("/api/{user}/stats")
def get_stats(user: str):
    db = get_db(user)
    total_activities = db.get_activity_count()
    total_km = db.get_total_distance_km()
    latest_date = db.get_latest_activity_date()

    weeks = db.query(
        """
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
        """
    )
    weekly = [dict(w) for w in weeks]
    for w in weekly:
        w["duration_fmt"] = format_duration(w["duration_s"])
        w["pace_fmt"] = pace_str(w["avg_pace"]) or "—"

    db.close()
    return {
        "total_activities": total_activities,
        "total_km": total_km,
        "latest_date": latest_date,
        "weekly": weekly,
    }


