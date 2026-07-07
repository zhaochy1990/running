"""Dashboard, daily health, PMC, and rollup stats."""

from __future__ import annotations

import json

from fastapi import APIRouter, Query

from stride_storage.sqlite.database import HRV_PREFERRED_PER_DATE_SQL
from stride_core.models import RUN_SPORT_SQL_LIST as _RUN_SPORT_SQL, pace_str
from stride_storage.sqlite.calibration_connector import SQLiteRunningCalibrationRepository
from stride_core.timefmt import today_shanghai

from ..deps import format_duration, get_db

router = APIRouter()


def _normalize_health_date(d):
    """Coerce `daily_health.date` to bare ISO ``YYYY-MM-DD``.

    The column stores ``YYYYMMDD`` for COROS-sourced rows and ISO
    ``YYYY-MM-DD`` (sometimes with a ``T...`` suffix) for Garmin-sourced
    rows — both already Shanghai-local. Frontend code joins these with
    ``daily_hrv.date`` (always ISO) and would silently miss COROS days
    without this normalization.
    """
    if not isinstance(d, str) or not d:
        return d
    if len(d) == 8 and d.isdigit():
        return f"{d[:4]}-{d[4:6]}-{d[6:]}"
    if len(d) >= 10 and d[4:5] == "-":
        return d[:10]
    return d


def _json_list(value) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed]


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
    health = []
    for r in rows:
        record = dict(r)
        record["date"] = _normalize_health_date(record.get("date"))
        health.append(record)

    # Init with every required HRVSnapshot field so the response shape stays
    # stable even for fresh users with no dashboard row yet.
    hrv = {
        "avg_sleep_hrv": None,
        "hrv_normal_low": None,
        "hrv_normal_high": None,
        "recovery_pct": None,
        "date": None,
    }
    dash = db.query(
        "SELECT avg_sleep_hrv, hrv_normal_low, hrv_normal_high, recovery_pct "
        "FROM dashboard WHERE id = 1"
    )
    if dash:
        hrv.update(dict(dash[0]))

    # Date of the most recent daily_hrv reading. Saves consumers from scanning
    # `hrv.trend` (which is windowed by `days`) just to label a card; the value
    # in `avg_sleep_hrv` above is a `dashboard`-table snapshot with no date of
    # its own, so this is the closest "as-of" we can attach to it.
    latest_hrv_date_row = db.query(
        f"SELECT date FROM ({HRV_PREFERRED_PER_DATE_SQL}) "
        "WHERE last_night_avg IS NOT NULL ORDER BY date DESC LIMIT 1"
    )
    if latest_hrv_date_row:
        hrv["date"] = latest_hrv_date_row[0]["date"]

    # Per-day HRV trend (both COROS and Garmin populate this now). Capped
    # at the same window as `health` so a single /health call gives the
    # training-status skill everything it needs to render the HRV row.
    # Returned oldest→newest to match /api/hrv and /api/pmc — chart-friendly.
    # The `daily_balanced_*` fields are renamed from the DB columns
    # `baseline_balanced_*` so consumers don't conflate them with the
    # `hrv_normal_*` user-level baseline above (`hrv_normal_*` is a stable
    # band from the dashboard; `daily_balanced_*` is the watch's per-day
    # threshold and is expected to drift day to day).
    hrv_trend_rows = db.query(
        "SELECT date, last_night_avg, status, "
        "baseline_balanced_low AS daily_balanced_low, "
        "baseline_balanced_upper AS daily_balanced_upper "
        f"FROM ({HRV_PREFERRED_PER_DATE_SQL}) ORDER BY date DESC LIMIT ?",
        (days,),
    )
    trend = [dict(r) for r in hrv_trend_rows]
    trend.reverse()
    hrv["trend"] = trend

    try:
        repo = SQLiteRunningCalibrationRepository(db)
        snap = repo.fetch_latest(as_of_date=today_shanghai())
        rhr_baseline = int(snap.rhr_baseline) if snap and snap.rhr_baseline is not None else None
    except Exception:  # noqa: BLE001
        # New user with no calibration snapshot yet is normal — return None.
        rhr_baseline = None

    db.close()
    return {
        "health": health,
        "hrv": hrv,
        "rhr_baseline": rhr_baseline,
    }


@router.get("/api/{user}/hrv")
def get_hrv(user: str, days: int = Query(30, ge=1, le=365)):
    """Per-day HRV detail (populated by both COROS and Garmin sync).

    Returns the last `days` rows from `daily_hrv` ordered oldest → newest
    (chart-friendly), plus a small summary block for the latest reading.
    COROS rows are derived from `/dashboard/query`'s sleepHrvList (last
    7 days per sync — trend accumulates over time); Garmin rows come from
    `get_hrv_data(date)` per day.

    The DB columns `baseline_balanced_low/upper` are aliased to
    `daily_balanced_low/upper` in the response so consumers see one
    consistent naming across `/api/hrv` and `/api/health.hrv.trend`.
    The label also disambiguates the per-day watch threshold from the
    user-level baseline range (`hrv_normal_low/high` on `/api/dashboard`).
    """
    db = get_db(user)
    rows = db.query(
        f"""SELECT date, weekly_avg, last_night_avg, last_night_5min_high,
                   status, baseline_low_upper,
                   baseline_balanced_low  AS daily_balanced_low,
                   baseline_balanced_upper AS daily_balanced_upper,
                   feedback_phrase, provider
            FROM ({HRV_PREFERRED_PER_DATE_SQL})
            ORDER BY date DESC LIMIT ?""",
        (days,),
    )
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
            "daily_balanced_low": latest.get("daily_balanced_low"),
            "daily_balanced_upper": latest.get("daily_balanced_upper"),
        },
    }


@router.get("/api/{user}/pmc")
def get_pmc(user: str, days: int = Query(90, ge=14, le=365)):
    """Performance Management Chart data: CTI (fitness), ATI (fatigue), TSB (form).

    TSB zone bands are derived from ACWR (`training_load_ratio = ATI/CTI`)
    rather than absolute TSB. Reason: COROS and Garmin ATI/CTI use different
    scales (COROS ~TRIMP, Garmin ~EPOC); Garmin's are typically 3-5× larger,
    so an absolute "TSB ≥ 10 = race ready" rule that works for COROS would
    flag every Garmin user as permanently overreaching. ACWR is unitless and
    behaves consistently across providers — exactly the same physiological
    interpretation of "today's load relative to recent baseline".
    """
    db = get_db(user)
    rows = db.query(
        "SELECT date, ati, cti, training_load_ratio, training_load_state, fatigue, rhr "
        "FROM daily_health ORDER BY date DESC LIMIT ?",
        (days,),
    )
    stride_rows = db.query(
        """WITH active_version AS (
               SELECT MAX(algorithm_version) AS algorithm_version
               FROM daily_training_load
           ),
           recent AS (
               SELECT date, algorithm_version, training_dose, acute_load, chronic_load,
                      form, load_ratio, readiness_gate, readiness_reasons_json
               FROM daily_training_load
               WHERE algorithm_version = (SELECT algorithm_version FROM active_version)
               ORDER BY date DESC
               LIMIT ?
           )
           SELECT recent.*,
                  prior.chronic_load AS chronic_load_7d_ago
           FROM recent
           LEFT JOIN daily_training_load AS prior
             ON prior.date = date(recent.date, '-7 day')
            AND prior.algorithm_version = recent.algorithm_version
           ORDER BY recent.date""",
        (days,),
    )
    db.close()

    records = [dict(r) for r in rows]
    records.reverse()

    for i, rec in enumerate(records):
        ati = rec.get("ati") or 0
        cti = rec.get("cti") or 0
        rec["tsb"] = round(cti - ati, 1)

        # Prefer the stored ACWR; derive from ATI/CTI if missing (older rows
        # may not have the ratio column populated, e.g. legacy COROS imports).
        ratio = rec.get("training_load_ratio")
        if ratio is None and cti > 0:
            ratio = ati / cti

        if ratio is None:
            rec["tsb_zone"] = "neutral"
            rec["tsb_zone_label"] = "维持期"
        elif ratio < 0.6:
            rec["tsb_zone"] = "overtaper"
            rec["tsb_zone_label"] = "减量过多"
        elif ratio < 0.85:
            rec["tsb_zone"] = "race_ready"
            rec["tsb_zone_label"] = "比赛就绪"
        elif ratio < 1.1:
            rec["tsb_zone"] = "neutral"
            rec["tsb_zone_label"] = "维持期"
        elif ratio < 1.3:
            rec["tsb_zone"] = "training"
            rec["tsb_zone_label"] = "提升期"
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

    stride_records = []
    for row in stride_rows:
        rec = dict(row)
        chronic_load = rec.get("chronic_load")
        prior_chronic = rec.pop("chronic_load_7d_ago", None)
        rec["readiness_reasons"] = _json_list(rec.pop("readiness_reasons_json", None))
        rec["chronic_load_ramp"] = (
            round(chronic_load - prior_chronic, 1)
            if chronic_load is not None and prior_chronic is not None
            else None
        )
        stride_records.append(rec)

    latest_stride = stride_records[-1] if stride_records else {}
    stride_summary = {
        "date": latest_stride.get("date"),
        "current_training_dose": latest_stride.get("training_dose"),
        "current_acute_load": latest_stride.get("acute_load"),
        "current_chronic_load": latest_stride.get("chronic_load"),
        "current_form": latest_stride.get("form"),
        "current_load_ratio": latest_stride.get("load_ratio"),
        "current_readiness_gate": latest_stride.get("readiness_gate"),
        "current_readiness_reasons": latest_stride.get("readiness_reasons"),
        "chronic_load_ramp": latest_stride.get("chronic_load_ramp"),
    }

    return {
        "pmc": records,
        "summary": summary,
        "stride_pmc": stride_records,
        "stride_summary": stride_summary,
    }


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
        WHERE sport_type IN (""" + _RUN_SPORT_SQL + """)
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


