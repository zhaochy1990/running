"""Weekly plan + activities + feedback aggregation."""

from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from stride_core.models import pace_str

from ..content_store import any_exists, exists as content_exists, list_week_folders, read_text
from ..deps import format_duration, get_db, parse_week_dates

router = APIRouter()


def _markdown_title(content: str) -> str:
    first_line = content.splitlines()[0].strip() if content.splitlines() else ""
    return first_line.lstrip("# ").strip()


@router.get("/api/{user}/weeks")
def list_weeks(user: str):
    """List all training weeks with plan info and activity summary."""
    db = get_db(user)
    weeks = []
    try:
        for folder_name in list_week_folders(user):
            dates = parse_week_dates(folder_name)
            if not dates:
                continue

            date_from, date_to = dates
            plan_rel = f"{user}/logs/{folder_name}/plan.md"
            feedback_rel = f"{user}/logs/{folder_name}/feedback.md"
            db_plan_row = db.get_weekly_plan_row(folder_name)
            db_feedback_row = db.get_weekly_feedback_row(folder_name)
            plan_item = None if db_plan_row is not None else read_text(plan_rel)
            has_plan = db_plan_row is not None or plan_item is not None
            week: dict = {
                "folder": folder_name,
                "date_from": date_from,
                "date_to": date_to,
                "has_plan": has_plan,
                "has_feedback": db_feedback_row is not None or content_exists(feedback_rel),
                "has_inbody": any_exists(
                    f"{user}/logs/{folder_name}/inbody{ext}"
                    for ext in [".jpg", ".png", ".jpeg"]
                ),
                "plan_source": "db" if db_plan_row is not None else (plan_item.source if plan_item else "none"),
            }

            if db_plan_row is not None:
                week["plan_title"] = _markdown_title(db_plan_row["content_md"])
                week["plan_updated_at"] = db_plan_row["updated_at"]
                week["plan_generated_by"] = db_plan_row["generated_by"]
            elif plan_item is not None:
                week["plan_title"] = _markdown_title(plan_item.content)

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
            week["total_duration_fmt"] = format_duration(summary.get("total_duration_s", 0))
            weeks.append(week)
    finally:
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

    # DB-edited/agent-adjusted plans win over the markdown file. The file
    # remains the seed/fallback for git-synced canonical weekly plans.
    db_plan_row = db.get_weekly_plan_row(folder)
    if db_plan_row is not None:
        result["plan"] = db_plan_row["content_md"]
        result["plan_source"] = "db"
        result["plan_updated_at"] = db_plan_row["updated_at"]
        result["plan_generated_by"] = db_plan_row["generated_by"]
    else:
        plan_item = read_text(f"{user}/logs/{folder}/plan.md")
        if plan_item is not None:
            result["plan"] = plan_item.content
            result["plan_source"] = plan_item.source
        else:
            result["plan_source"] = "none"

    # DB-edited feedback wins over the markdown file. The file remains as
    # a seed/fallback so legacy weeks still display until edited in-app.
    db_fb_row = db.get_weekly_feedback_row(folder)

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
    activities = []
    for r in rows:
        d = dict(r)
        d["distance_km"] = round(d["distance_m"], 2) if d["distance_m"] else 0
        d["duration_fmt"] = format_duration(d["duration_s"])
        d["pace_fmt"] = pace_str(d["avg_pace_s_km"]) or "—"
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
            date_str = a["date"][:10] if a.get("date") else ""
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

    db = get_db(user)
    try:
        db.upsert_weekly_feedback(folder, content, generated_by=generated_by)
        row = db.get_weekly_feedback_row(folder)
    finally:
        db.close()

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

    db = get_db(user)
    try:
        db.upsert_weekly_plan(folder, content, generated_by=generated_by)
        row = db.get_weekly_plan_row(folder)
    finally:
        db.close()

    return {
        "success": True,
        "week": folder,
        "plan_source": "db",
        "plan_updated_at": row["updated_at"] if row else None,
        "plan_generated_by": row["generated_by"] if row else None,
    }
