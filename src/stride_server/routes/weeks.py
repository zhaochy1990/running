"""Weekly plan + activities + feedback aggregation."""

from __future__ import annotations

from fastapi import APIRouter

from stride_core.models import pace_str

from ..deps import format_duration, get_db, get_logs_dir, parse_week_dates

router = APIRouter()


@router.get("/api/{user}/weeks")
def list_weeks(user: str):
    """List all training weeks with plan info and activity summary."""
    db = get_db(user)
    logs_dir = get_logs_dir(user)
    weeks = []
    if logs_dir.exists():
        for folder in sorted(logs_dir.iterdir(), reverse=True):
            if not folder.is_dir():
                continue
            dates = parse_week_dates(folder.name)
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

            if week["has_plan"]:
                with open(folder / "plan.md", "r", encoding="utf-8") as f:
                    week["plan_title"] = f.readline().strip().lstrip("# ")

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

    logs_dir = get_logs_dir(user)

    plan_path = logs_dir / folder / "plan.md"
    if plan_path.exists():
        with open(plan_path, "r", encoding="utf-8") as f:
            result["plan"] = f.read()

    feedback_path = logs_dir / folder / "feedback.md"
    feedback_parts: list[str] = []
    if feedback_path.exists():
        with open(feedback_path, "r", encoding="utf-8") as f:
            feedback_parts.append(f.read())

    db = get_db(user)
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

    # Append sport_notes from DB activities not already in feedback.md
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
