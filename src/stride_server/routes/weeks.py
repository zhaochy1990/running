"""Weekly plan + activities + feedback aggregation."""

from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from stride_core.distance import meters_to_km_zero
from stride_core.models import pace_str
from stride_core.timefmt import (
    SHANGHAI_DAY_SQL,
    shanghai_day_str,
    utc_iso_to_shanghai_iso,
)

from ..content_store import (
    any_exists,
    exists as content_exists,
    list_files_in_folder,
    list_week_folders,
    read_text,
    write_text,
)


_BODY_COMP_EXTS = (".json", ".jpg", ".jpeg", ".png")
_BODY_COMP_PREFIXES = ("body-composition.", "inbody.")


def _has_body_composition_file(files: list[str]) -> bool:
    """True if any filename matches the body-composition.* / inbody.* pattern.

    Accepts suffixed variants (e.g. ``body-composition.4-14.json``) — the
    only requirement is that the basename starts with one of the known
    prefixes AND ends with a recognized extension.
    """
    return any(
        f.startswith(_BODY_COMP_PREFIXES) and f.endswith(_BODY_COMP_EXTS)
        for f in files
    )
from ..deps import (
    format_duration,
    get_db,
    get_plan_state_store,
    parse_week_dates,
)
from ..weekly_plan_store import (
    get_weekly_plan_store, nutrition_to_api, session_to_api,
)

router = APIRouter()


def _markdown_title(content: str) -> str:
    first_line = content.splitlines()[0].strip() if content.splitlines() else ""
    return first_line.lstrip("# ").strip()


@router.get("/api/{user}/weeks")
def list_weeks(user: str):
    """List all training weeks with plan info and activity summary."""
    db = get_db(user)
    plan_store = get_plan_state_store(user)
    weeks = []
    try:
        canonical = {
            plan.week_folder: plan
            for plan in get_weekly_plan_store().list_plans(user)
        }
        folders = set(list_week_folders(user)) | set(canonical)
        for folder_name in sorted(folders, reverse=True):
            dates = parse_week_dates(folder_name)
            if not dates:
                continue

            date_from, date_to = dates
            plan_rel = f"{user}/logs/{folder_name}/plan.md"
            feedback_rel = f"{user}/logs/{folder_name}/feedback.md"
            db_feedback_row = plan_store.get_weekly_feedback_row(folder_name)
            plan_item = read_text(plan_rel)
            structured_plan = canonical.get(folder_name)
            has_plan = structured_plan is not None or plan_item is not None
            week: dict = {
                "folder": folder_name,
                "date_from": date_from,
                "date_to": date_to,
                "has_plan": has_plan,
                "has_feedback": db_feedback_row is not None or content_exists(feedback_rel),
                "has_body_composition": _has_body_composition_file(
                    list_files_in_folder(f"{user}/logs/{folder_name}")
                ),
                "plan_source": plan_item.source if plan_item else ("weekly_plan_store" if structured_plan else "none"),
            }

            if plan_item is not None:
                week["plan_title"] = _markdown_title(plan_item.content)
            elif structured_plan is not None:
                week["plan_title"] = folder_name

            # date_from / date_to are Shanghai-local YYYY-MM-DD; activities.date
            # is UTC ISO. Use SHANGHAI_DAY_SQL so the comparison happens in the
            # Shanghai calendar (see stride_core/timefmt.py).
            rows = db.query(
                f"""SELECT count(*) as cnt,
                    round(coalesce(sum(distance_m), 0) / 1000.0, 1) as total_km,
                    round(coalesce(sum(duration_s), 0), 0) as total_duration_s
                FROM activities WHERE {SHANGHAI_DAY_SQL} BETWEEN ? AND ?""",
                (date_from, date_to),
            )
            summary = dict(rows[0]) if rows else {}
            week["activity_count"] = summary.get("cnt", 0)
            week["total_km"] = summary.get("total_km", 0)
            week["total_duration_s"] = summary.get("total_duration_s", 0)
            week["total_duration_fmt"] = format_duration(summary.get("total_duration_s", 0))
            weeks.append(week)
    finally:
        plan_store.close()
        db.close()
    return {"weeks": weeks}


@router.get("/api/{user}/weeks/{folder}")
def get_week(user: str, folder: str):
    """Get full week data: plan content + activities list + merged feedback."""
    dates = parse_week_dates(folder)
    if not dates:
        return {"error": "Invalid folder"}, 400

    date_from, date_to = dates
    result: dict = {"folder": folder, "date_from": date_from, "date_to": date_to}

    db = get_db(user)
    plan_store = get_plan_state_store(user)

    plan_item = read_text(f"{user}/logs/{folder}/plan.md")
    if plan_item is not None:
        result["plan"] = plan_item.content
        result["plan_source"] = plan_item.source
    else:
        result["plan_source"] = "none"

    # DB-edited feedback wins over the markdown file. The file remains as
    # a seed/fallback so legacy weeks still display until edited in-app.
    db_fb_row = plan_store.get_weekly_feedback_row(folder)

    feedback_parts: list[str] = []
    if db_fb_row is not None:
        feedback_parts.append(db_fb_row["content_md"])
        result["feedback_source"] = "db"
        result["feedback_updated_at"] = db_fb_row["updated_at"]
        result["feedback_generated_by"] = db_fb_row["generated_by"]
    else:
        feedback_item = read_text(f"{user}/logs/{folder}/feedback.md")
        if feedback_item is not None:
            feedback_parts.append(feedback_item.content)
            result["feedback_source"] = feedback_item.source
        else:
            result["feedback_source"] = "none"

    rows = db.query(
        f"""SELECT label_id, name, sport_type, sport_name, date,
            distance_m, duration_s, avg_pace_s_km, avg_hr, max_hr,
            avg_cadence, calories_kcal, training_load, vo2max, train_type,
            ascent_m, aerobic_effect, anaerobic_effect,
            temperature, humidity, feels_like, wind_speed,
            feel_type, sport_note, route_thumb_json
        FROM activities WHERE {SHANGHAI_DAY_SQL} BETWEEN ? AND ?
        ORDER BY date ASC, label_id ASC""",
        (date_from, date_to),
    )
    activities = []
    for r in rows:
        d = dict(r)
        # Convert the UTC-stored timestamp to Shanghai-local ISO so the
        # frontend's `slice(0, 10)` / `slice(5, 10)` / weekday classification
        # all read correctly. The instant is preserved (offset is +08:00, not
        # stripped) so new Date(d.date) still resolves to the same moment.
        d["date"] = utc_iso_to_shanghai_iso(d["date"])
        d["distance_km"] = meters_to_km_zero(d.get("distance_m"), digits=2)
        d["duration_fmt"] = format_duration(d["duration_s"])
        d["pace_fmt"] = pace_str(d["avg_pace_s_km"]) or "—"
        # Decode pre-computed route thumbnail (NULL for indoor/strength).
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

    result["activities"] = activities

    # Append sport_notes from DB activities not already in feedback.md.
    # Skip this auto-merge when the canonical content is a user-edited DB row —
    # in that case the saved content is authoritative and adding sport_notes
    # would silently mutate what the user explicitly saved.
    if result.get("feedback_source") != "db":
        FEEL_LABELS = {1: "很好", 2: "好", 3: "一般", 4: "差", 5: "很差"}
        existing_feedback = feedback_parts[0] if feedback_parts else ""
        existing_normalized = existing_feedback.replace("- ", "").replace("* ", "")
        for a in activities:
            note = a.get("sport_note")
            if not note:
                continue
            first_line = note.strip().split("\n")[0].strip()[:20]
            if first_line and first_line in existing_normalized:
                continue
            date_str = shanghai_day_str(a.get("date"))
            feel = FEEL_LABELS.get(a.get("feel_type") or 0, "")
            header = f"{date_str} {a.get('name', '')}"
            if feel:
                header += f"（体感：{feel}）"
            feedback_parts.append(f"{header}\n\n{note}")

    if feedback_parts:
        result["feedback"] = "\n\n---\n\n".join(feedback_parts)

    result["total_km"] = round(sum(a["distance_km"] for a in activities), 1)
    result["total_duration_s"] = sum(a["duration_s"] or 0 for a in activities)
    result["total_duration_fmt"] = format_duration(result["total_duration_s"])
    result["activity_count"] = len(activities)

    # Additive: structured-plan layer (sessions + nutrition + status). Old
    # frontends ignore unknown keys; new ones can light up the calendar tab.
    canonical_plan = get_weekly_plan_store().get_plan(user, folder)
    legacy_row = None
    legacy_plan = None
    if canonical_plan is None:
        legacy_row = plan_store.get_weekly_plan_row(folder)
        try:
            legacy_plan = plan_store.get_structured_weekly_plan(folder)
        except (ValueError, TypeError, KeyError):
            legacy_plan = None
    display_plan = canonical_plan or legacy_plan
    sessions_payload = []
    nutrition_payload = []
    if display_plan is not None:
        for session in display_plan.sessions:
            sw = db.get_latest_scheduled_workout_for_plan_session(
                folder, session.date, session.session_index
            )
            sessions_payload.append(
                session_to_api(
                    folder, session,
                    scheduled_workout_id=int(sw["id"]) if sw else None,
                )
            )
        nutrition_payload = [nutrition_to_api(item) for item in display_plan.nutrition]
    result["structured"] = {
        "structured_status": (
            "canonical" if canonical_plan else
            legacy_row["structured_status"] if legacy_row is not None else None
        ),
        "structured_parsed_at": (
            legacy_row["structured_parsed_at"] if legacy_row is not None else None
        ),
        "sessions": sessions_payload,
        "nutrition": nutrition_payload,
    }

    # Multi-variant summary (Step 2). Additive — old frontends ignore.
    # Lists ACTIVE variants only (superseded ones aren't relevant for
    # the summary card). `selected_variant_id` mirrors the field on
    # weekly_plan; null when nothing's been promoted yet.
    variant_rows = plan_store.get_weekly_plan_variants(folder)
    selected_vid = None
    source = get_weekly_plan_store().get_generated_by(user, folder)
    if source and source.startswith("selected-variant:"):
        selected_vid = int(source.split(":", 1)[1])
    result["variants_summary"] = {
        "total": len(variant_rows),
        "selected_variant_id": selected_vid,
        "model_ids": [r["model_id"] for r in variant_rows],
    }

    # Multi-variant fallback design (Step 4): surface scheduled_workout
    # rows in this week that were marked `abandoned_by_promote_at` by a
    # prior variant promote. Frontend renders a red banner over the
    # canonical view + an activity-detail warning so the user knows to
    # delete the orphan [STRIDE] entries on COROS App. Only NON-NULL rows
    # are returned; an empty list means "no orphans for this week".
    abandoned_rows = db.query(
        """SELECT id, date, name, abandoned_by_promote_at
             FROM scheduled_workout
            WHERE date >= ? AND date <= ?
              AND abandoned_by_promote_at IS NOT NULL
            ORDER BY date, id""",
        (date_from, date_to),
    )
    result["abandoned_scheduled_workouts"] = [
        {
            "id": r["id"],
            "date": r["date"],
            "name": r["name"],
            "abandoned_by_promote_at": r["abandoned_by_promote_at"],
        }
        for r in abandoned_rows
    ]

    plan_store.close()
    db.close()
    return result


@router.put("/api/{user}/weeks/{folder}/feedback")
def update_weekly_feedback(user: str, folder: str, payload: dict = Body(...)):
    """Save user-edited rich-text (markdown) feedback for a training week.

    The DB row becomes the canonical content for this week; the on-disk
    feedback.md (synced via git) is no longer used for display once a row
    exists. ``verify_path_user`` (router-level dep) enforces that the path
    user matches the JWT subject — i.e. users can only edit their own.

    Body: ``{"content": "<markdown>", "generated_by": "<model-id>"?}``
    """
    if not parse_week_dates(folder):
        raise HTTPException(status_code=400, detail="Invalid folder")

    content = payload.get("content")
    if not isinstance(content, str):
        raise HTTPException(status_code=422, detail="content is required (string)")
    generated_by = payload.get("generated_by")
    if generated_by is not None and not isinstance(generated_by, str):
        raise HTTPException(status_code=422, detail="generated_by must be a string or null")

    plan_store = get_plan_state_store(user)
    try:
        plan_store.upsert_weekly_feedback(folder, content, generated_by=generated_by)
        row = plan_store.get_weekly_feedback_row(folder)
    finally:
        plan_store.close()

    return {
        "success": True,
        "week": folder,
        "feedback_source": "db",
        "feedback_updated_at": row["updated_at"] if row else None,
        "feedback_generated_by": row["generated_by"] if row else None,
    }


@router.put("/api/{user}/weeks/{folder}/plan")
def update_weekly_plan(user: str, folder: str, payload: dict = Body(...)):
    """Save a DB-backed markdown plan override for a training week.

    The DB row becomes the canonical content for this week in the API while the
    on-disk plan.md remains untouched. This is the persistence target for
    agent-generated plan adjustments after the user explicitly confirms them.

    Body: ``{"content": "<markdown>", "generated_by": "<model-id>"?}``
    """
    if not parse_week_dates(folder):
        raise HTTPException(status_code=400, detail="Invalid folder")

    content = payload.get("content")
    if not isinstance(content, str):
        raise HTTPException(status_code=422, detail="content is required (string)")
    generated_by = payload.get("generated_by")
    if generated_by is not None and not isinstance(generated_by, str):
        raise HTTPException(status_code=422, detail="generated_by must be a string or null")

    write_text(f"{user}/logs/{folder}/plan.md", content)

    return {
        "success": True,
        "week": folder,
        "plan_source": "content_store",
        "plan_updated_at": None,
        "plan_generated_by": generated_by,
    }
