"""Activity list + detail + single-activity resync."""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query

from stride_core.models import EXERCISE_TYPES, pace_str
from stride_core.source import DataSource

from ..bearer import require_bearer
from ..deps import EXERCISE_NAMES, format_duration, get_db, get_source

router = APIRouter()


@router.get("/api/{user}/activities")
def list_activities(
    user: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    sport: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
):
    db = get_db(user)
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
        d["duration_fmt"] = format_duration(d["duration_s"])
        d["pace_fmt"] = pace_str(d["avg_pace_s_km"]) or "—"
        activities.append(d)

    return {"total": total_count, "offset": offset, "limit": limit, "activities": activities}


@router.get("/api/{user}/activities/{label_id}")
def get_activity(user: str, label_id: str):
    db = get_db(user)

    rows = db.query("SELECT * FROM activities WHERE label_id = ?", (label_id,))
    if not rows:
        db.close()
        return {"error": "Not found"}, 404

    activity = dict(rows[0])
    activity["distance_km"] = round(activity["distance_m"], 2) if activity["distance_m"] else 0
    activity["duration_fmt"] = format_duration(activity["duration_s"])
    activity["pace_fmt"] = pace_str(activity["avg_pace_s_km"]) or "—"

    commentary_row = db.get_activity_commentary_row(label_id)
    if commentary_row:
        cd = dict(commentary_row)
        activity["commentary"] = cd.get("commentary")
        activity["commentary_generated_by"] = cd.get("generated_by")
        activity["commentary_generated_at"] = cd.get("generated_at")

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
        ld["duration_fmt"] = format_duration(ld["duration_s"])
        ld["pace_fmt"] = pace_str(ld["avg_pace"]) or "—"
        laps.append(ld)

    # Segments - type2 (workout structure from COROS exerciseType)
    seg_rows = db.query(
        """SELECT lap_index, lap_type, distance_m, duration_s, avg_pace,
           adjusted_pace, avg_hr, max_hr, avg_cadence, avg_power, ascent_m, descent_m,
           exercise_type, exercise_name_key, mode
        FROM laps WHERE label_id = ? AND lap_type = 'type2'
        ORDER BY lap_index""",
        (label_id,),
    )
    segments = []
    for sr in seg_rows:
        sd = dict(sr)
        sd["distance_km"] = round(sd["distance_m"], 2) if sd["distance_m"] else 0
        sd["duration_fmt"] = format_duration(sd["duration_s"])
        sd["pace_fmt"] = pace_str(sd["avg_pace"]) or "—"
        name_key = sd.get("exercise_name_key")
        if name_key and name_key in EXERCISE_NAMES:
            sd["seg_name"] = EXERCISE_NAMES[name_key]
        elif name_key and name_key.startswith("sid_strength_"):
            sd["seg_name"] = name_key.replace("sid_strength_", "").replace("_", " ").title()
        else:
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


@router.post("/api/{user}/activities/{label_id}/commentary")
def upsert_commentary(
    user: str,
    label_id: str,
    payload: dict = Body(...),
    _claims: dict = Depends(require_bearer),
):
    """Upsert coach commentary (markdown) for a single activity.

    Body: `{"commentary": "...", "generated_by": "claude-opus-4-7" | null}`
    Protected by Bearer auth when STRIDE_AUTH_PUBLIC_KEY_PEM/PATH is set.
    """
    commentary = payload.get("commentary")
    if not isinstance(commentary, str) or not commentary.strip():
        return {"success": False, "error": "commentary is required"}, 422
    generated_by = payload.get("generated_by")
    if generated_by is not None and not isinstance(generated_by, str):
        return {"success": False, "error": "generated_by must be a string or null"}, 422

    db = get_db(user)
    try:
        db.upsert_activity_commentary(label_id, commentary, generated_by=generated_by)
    finally:
        db.close()
    return {"success": True, "generated_by": generated_by}


@router.post("/api/{user}/activities/{label_id}/commentary/regenerate")
def regenerate_commentary(
    user: str,
    label_id: str,
    _claims: dict = Depends(require_bearer),
):
    """Force AOAI to (re)generate commentary for an activity, overwriting any existing row.

    Returns 503 if AOAI is disabled or not configured.
    """
    from ..commentary_ai import regenerate_and_save
    from ..aoai_client import AOAIUnavailable

    db = get_db(user)
    try:
        try:
            row = regenerate_and_save(user, label_id, db=db)
        except AOAIUnavailable as e:
            return {"success": False, "error": f"AOAI unavailable: {e}"}, 503
        except LookupError as e:
            return {"success": False, "error": str(e)}, 404
        except Exception as e:
            return {"success": False, "error": f"AOAI call failed: {e}"}, 502
    finally:
        db.close()

    return {
        "success": True,
        "commentary": row.get("commentary"),
        "generated_by": row.get("generated_by"),
        "generated_at": row.get("generated_at"),
    }


@router.post("/api/{user}/activities/{label_id}/resync")
def resync_activity(
    user: str,
    label_id: str,
    source: DataSource = Depends(get_source),
    _claims: dict = Depends(require_bearer),
):
    """Re-sync a single activity (to pick up updated feedback/sport_note).

    Protected by Bearer auth when STRIDE_AUTH_PUBLIC_KEY_PEM/PATH is set.
    """
    try:
        if not source.is_logged_in(user):
            return {"success": False, "error": f"用户 {user} 未登录"}
        source.resync_activity(user, label_id)
        return {"success": True}
    except LookupError:
        return {"success": False, "error": "活动不存在"}
    except Exception as e:
        return {"success": False, "error": str(e)}
