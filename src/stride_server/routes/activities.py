"""Activity list + detail + single-activity resync."""

from __future__ import annotations

import logging
import json
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response

from stride_core.models import EXERCISE_TYPES, pace_str
from stride_core.distance import meters_to_km_zero
from stride_core.post_sync import run_post_sync_for_labels
from stride_core.source import DataSource
from stride_core.timefmt import utc_iso_to_shanghai_iso

from ..bearer import require_bearer
from ..deps import (
    EXERCISE_NAMES,
    format_duration,
    get_commentary_store,
    get_db,
    get_source,
    get_source_for_user,
)

logger = logging.getLogger(__name__)

router = APIRouter()

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


def _serialize_activity_training_load(row) -> dict | None:
    if not row:
        return None
    rec = dict(row)
    return {
        "label_id": rec.get("label_id"),
        "activity_date": rec.get("activity_date"),
        "sport": rec.get("sport"),
        "session_class": rec.get("session_class"),
        "algorithm_version": rec.get("algorithm_version"),
        "calibration_id": rec.get("calibration_id"),
        "cardio_load_raw": rec.get("cardio_load_raw"),
        "cardio_tss": rec.get("cardio_tss"),
        "external_tss": rec.get("external_tss"),
        "mechanical_load": rec.get("mechanical_load"),
        "subjective_internal_load": rec.get("subjective_internal_load"),
        "training_dose": rec.get("training_dose"),
        "load_confidence": rec.get("load_confidence"),
        "excluded_from_pmc": bool(rec.get("excluded_from_pmc")),
        "reasons": _json_list(rec.get("reasons_json")),
    }


@router.get("/api/{user}/activities")
def list_activities(
    user: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    sport: str | None = None,
    sport_category: Literal["run", "strength"] | None = None,
    min_distance_km: float | None = Query(None, ge=0),
    date_from: str | None = None,
    date_to: str | None = None,
):
    db = get_db(user)
    result = db.list_activities(
        offset=offset,
        limit=limit,
        sport=sport,
        sport_category=sport_category,
        min_distance_km=min_distance_km,
        date_from=date_from,
        date_to=date_to,
    )
    db.close()

    activities = []
    for r in result["rows"]:
        d = dict(r)
        d.pop("shanghai_month", None)
        # UTC → Shanghai ISO at the API boundary; see stride_core/timefmt.py.
        d["date"] = utc_iso_to_shanghai_iso(d["date"])
        d["distance_km"] = meters_to_km_zero(d.get("distance_m"), digits=2)
        d["duration_fmt"] = format_duration(d["duration_s"])
        d["pace_fmt"] = pace_str(d["avg_pace_s_km"]) or "—"
        # Decode route_thumb JSON server-side so the client can drop the
        # array straight into an SVG <polyline>. NULL → empty so the
        # frontend can branch on `.length === 0`.
        raw_thumb = d.pop("route_thumb_json", None)
        if isinstance(raw_thumb, str) and raw_thumb:
            try:
                import json as _json
                d["route_thumb"] = _json.loads(raw_thumb)
            except (ValueError, TypeError):
                d["route_thumb"] = None
        else:
            d["route_thumb"] = None
        activities.append(d)

    return {
        "total": result["total"],
        "offset": offset,
        "limit": limit,
        "activities": activities,
        "monthly_summaries": result["monthly_summaries"],
    }


def build_activity_detail(db, label_id: str, commentary_store=None) -> dict | None:
    """Assemble the activity detail payload from an open Database connection.

    Returns ``None`` when the activity is not present. Caller owns the db
    handle (do not close it here) — used by both ``/api/{user}/activities/...``
    and the team-scoped detail endpoint in routes/teams.py.
    """
    rows = db.query("SELECT * FROM activities WHERE label_id = ?", (label_id,))
    if not rows:
        return None

    activity = dict(rows[0])
    # UTC → Shanghai ISO at the API boundary; see stride_core/timefmt.py.
    activity["date"] = utc_iso_to_shanghai_iso(activity["date"])
    activity["distance_km"] = meters_to_km_zero(activity.get("distance_m"), digits=2)
    activity["duration_fmt"] = format_duration(activity["duration_s"])
    activity["pace_fmt"] = pace_str(activity["avg_pace_s_km"]) or "—"
    # `pauses` is stored as a JSON string (or NULL); decode for the client
    # so the frontend can render polyline gaps without extra parsing.
    raw_pauses = activity.get("pauses")
    if isinstance(raw_pauses, str) and raw_pauses:
        try:
            import json as _json
            activity["pauses"] = _json.loads(raw_pauses)
        except (ValueError, TypeError):
            activity["pauses"] = []
    else:
        activity["pauses"] = []

    # Commentary lives in a Phase-1 abstracted store; callers may pass one in,
    # otherwise we wrap the local db so legacy callers keep working unchanged.
    if commentary_store is None:
        from stride_storage.sqlite.state_stores import SqliteCommentaryStore
        commentary_store = SqliteCommentaryStore(db)
    commentary_row = commentary_store.get_activity_commentary_row(label_id)
    if commentary_row:
        cd = dict(commentary_row)
        activity["commentary"] = cd.get("commentary")
        activity["commentary_generated_by"] = cd.get("generated_by")
        activity["commentary_generated_at"] = cd.get("generated_at")

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
        ld["distance_km"] = meters_to_km_zero(ld.get("distance_m"), digits=2)
        ld["duration_fmt"] = format_duration(ld["duration_s"])
        ld["pace_fmt"] = pace_str(ld["avg_pace"]) or "—"
        laps.append(ld)

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
        sd["distance_km"] = meters_to_km_zero(sd.get("distance_m"), digits=2)
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

    zones_rows = db.query(
        """SELECT zone_type, zone_index, range_min, range_max, range_unit, duration_s, percent
        FROM zones WHERE label_id = ?
        ORDER BY zone_type, zone_index""",
        (label_id,),
    )
    zones = [dict(z) for z in zones_rows]

    stride_training_load = _serialize_activity_training_load(
        db.fetch_activity_training_load(label_id)
    )

    ts_rows = db.query(
        """SELECT timestamp, distance, heart_rate, speed, adjusted_pace, cadence, altitude, power,
                  gps_lat, gps_lon
        FROM timeseries WHERE label_id = ?
        ORDER BY rowid""",
        (label_id,),
    )
    all_ts = [dict(t) for t in ts_rows]
    # Downsample to ~1000 points. HRChart/PaceChart only render ~500 visible
    # so this is plenty for them; the GPS polyline benefits from the extra
    # detail (a marathon downsampled to 500 has ~80m spacing between points,
    # which looks blocky on tight switchbacks). 1000 → ~40m worst case.
    step = max(1, len(all_ts) // 1000)
    timeseries = all_ts[::step]

    return {
        "activity": activity,
        "stride_training_load": stride_training_load,
        "laps": laps,
        "segments": segments,
        "zones": zones,
        "timeseries": timeseries,
    }


@router.get("/api/{user}/activities/{label_id}")
def get_activity(user: str, label_id: str, include: str | None = Query(None)):
    db = get_db(user)
    commentary_store = get_commentary_store(user)
    try:
        result = build_activity_detail(db, label_id, commentary_store=commentary_store)
        # Multi-variant fallback design (Step 4): if a scheduled_workout
        # was linked to this activity (via completed_label_id) AND it's
        # been marked abandoned by a later variant promote, surface
        # that flag so the activity-detail page can render a warning
        # card. The link is null when no scheduled_workout completed
        # via this activity.
        sw_link = None
        if result is not None:
            row = db._conn.execute(
                """SELECT id, abandoned_by_promote_at
                     FROM scheduled_workout
                    WHERE completed_label_id = ?
                    LIMIT 1""",
                (label_id,),
            ).fetchone()
            if row is not None:
                sw_link = {
                    "id": row["id"],
                    "abandoned_by_promote_at": row["abandoned_by_promote_at"],
                }
            result["linked_scheduled_workout"] = sw_link
    finally:
        commentary_store.close()
        db.close()
    if result is None:
        raise HTTPException(status_code=404, detail="Not found")
    # M1 mobile contract: strip the heavy `timeseries` array by default.
    # Web clients that still need the inline series pass `?include=timeseries`.
    includes = {tok.strip() for tok in (include or "").split(",") if tok.strip()}
    if "timeseries" not in includes:
        result.pop("timeseries", None)
    return result


@router.get("/api/{user}/activities/{label_id}/timeseries")
def get_activity_timeseries(
    user: str,
    label_id: str,
    response: Response,
    downsample: int = Query(300, ge=1, le=2000),
    fields: str = Query("hr,pace,altitude,cadence"),
):
    """Per-activity downsampled time-series for charts.

    Field map: ``hr→heart_rate``, ``pace→adjusted_pace``,
    ``altitude→altitude``, ``cadence→cadence``. Unknown field names
    return 400. Response is cached for 1 day (`immutable`) since
    timeseries are append-only once an activity is fully synced.
    """
    from stride_core.timeseries import downsample_series

    field_map = {
        "hr": "heart_rate",
        "pace": "adjusted_pace",
        "altitude": "altitude",
        "cadence": "cadence",
    }
    requested = [f.strip() for f in fields.split(",") if f.strip()]
    unknown = [f for f in requested if f not in field_map]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"unknown fields: {','.join(unknown)}",
        )

    db = get_db(user)
    try:
        rows = db.query(
            "SELECT label_id, duration_s FROM activities WHERE label_id = ?",
            (label_id,),
        )
        if not rows:
            raise HTTPException(status_code=404, detail="Not found")
        duration_s = rows[0]["duration_s"] or 0

        ts_rows = db.query(
            """SELECT timestamp, heart_rate, adjusted_pace, altitude, cadence
            FROM timeseries WHERE label_id = ? ORDER BY rowid""",
            (label_id,),
        )
    finally:
        db.close()

    point_count = len(ts_rows)
    series: dict[str, list[float | None]] = {}
    if point_count == 0:
        for f in requested:
            series[f] = []
        interval_sec = 0.0
    else:
        for f in requested:
            col = field_map[f]
            raw = [r[col] for r in ts_rows]
            series[f] = downsample_series(raw, downsample)
        bucket_n = min(point_count, downsample)
        interval_sec = (duration_s / bucket_n) if bucket_n else 0.0

    response.headers["Cache-Control"] = "public, max-age=86400, immutable"
    return {
        "label_id": label_id,
        "duration_sec": duration_s,
        "point_count": point_count,
        "interval_sec": interval_sec,
        "series": series,
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
        raise HTTPException(status_code=422, detail="commentary is required")
    generated_by = payload.get("generated_by")
    if generated_by is not None and not isinstance(generated_by, str):
        raise HTTPException(status_code=422, detail="generated_by must be a string or null")

    commentary_store = get_commentary_store(user)
    try:
        commentary_store.upsert_activity_commentary(
            label_id, commentary, generated_by=generated_by,
        )
    finally:
        commentary_store.close()
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
    from ..commentary_ai import AOAIUnavailable, regenerate_and_save

    db = get_db(user)
    try:
        try:
            row = regenerate_and_save(user, label_id, db=db)
        except AOAIUnavailable as e:
            raise HTTPException(status_code=503, detail=f"AOAI unavailable: {e}")
        except LookupError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"AOAI call failed: {e}")
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
    source: DataSource = Depends(get_source_for_user),
    _claims: dict = Depends(require_bearer),
):
    """Re-sync a single activity (to pick up updated feedback/sport_note).

    Protected by Bearer auth when STRIDE_AUTH_PUBLIC_KEY_PEM/PATH is set.
    """
    try:
        if not source.is_logged_in(user):
            return {"success": False, "error": f"用户 {user} 未登录"}
        source.resync_activity(user, label_id)
        try:
            run_post_sync_for_labels(
                user=user,
                provider=source.info.name,
                operation="resync_activity",
                activity_label_ids=(label_id,),
            )
        except Exception:
            logger.exception("post-sync events failed for user=%s label_id=%s", user, label_id)
        return {"success": True}
    except LookupError:
        return {"success": False, "error": "活动不存在"}
    except Exception:
        logger.exception("resync failed for user=%s label_id=%s", user, label_id)
        return {"success": False, "error": "resync failed"}
