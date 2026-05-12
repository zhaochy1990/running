"""Weekly review endpoint — T12.

GET /api/{user}/weeks/{folder}/review

Aggregates:
  - summary  (distance / duration / completion_rate / avg_rpe)
  - tsb_series (7 days of ATI/CTI/TSB from daily_health)
  - sessions  (planned × actual LEFT JOIN + feedback)
  - activity_highlights (up to 3 recent activities with commentary)
  - insights  (rule-based, see review_insights.py)
  - next_week_preview (if next week folder exists)
"""

from __future__ import annotations

import json
import re
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException

from stride_core.timefmt import SHANGHAI_DAY_SQL

from ..content_store import list_week_folders
from ..deps import (
    format_duration,
    get_db,
    get_plan_state_store,
    parse_week_dates,
)
from ..review_insights import generate_insights

router = APIRouter()

# Run sport_type codes matching the rest of the codebase.
_RUN_SPORT_TYPES = (100, 101, 102, 103, 110, 111, 112)


def _next_week_folder(current_folder: str, user: str) -> str | None:
    """Return the folder name for the week immediately after current_folder, or None."""
    dates = parse_week_dates(current_folder)
    if not dates:
        return None
    _, date_to = dates
    try:
        next_monday = date.fromisoformat(date_to) + timedelta(days=1)
    except ValueError:
        return None

    # Walk all known folders and find the one whose date_from == next_monday
    try:
        all_folders = list(list_week_folders(user))
    except Exception:
        return None
    target = next_monday.isoformat()
    for f in all_folders:
        d = parse_week_dates(f)
        if d and d[0] == target:
            return f
    return None


def _completion_rate_history(user: str, current_folder: str, n: int = 4) -> list[float]:
    """Return completion rates for the N weeks prior to current_folder (oldest first).

    Used for streak detection in the insight engine. Returns an empty list when
    there are not enough planned_session rows to compute meaningful rates.
    """
    try:
        all_folders = sorted(list(list_week_folders(user)))
    except Exception:
        return []

    try:
        idx = all_folders.index(current_folder)
    except ValueError:
        return []

    prior_folders = all_folders[max(0, idx - n): idx]
    rates: list[float] = []

    plan_store = get_plan_state_store(user)
    try:
        for folder in prior_folders:
            dates = parse_week_dates(folder)
            if not dates:
                continue
            date_from, date_to = dates
            sessions = plan_store.get_planned_sessions(week_folder=folder)
            if not sessions:
                continue
            db = get_db(user)
            try:
                act_rows = db.query(
                    f"""SELECT label_id, {SHANGHAI_DAY_SQL} AS shanghai_date
                        FROM activities
                        WHERE {SHANGHAI_DAY_SQL} BETWEEN ? AND ?
                        ORDER BY shanghai_date""",
                    (date_from, date_to),
                )
            finally:
                db.close()
            # Simple heuristic: completed = planned sessions whose Shanghai
            # calendar day has >=1 actual activity. Match against the SQL-
            # computed shanghai_date column rather than slicing the raw UTC
            # `activities.date`, which would be off by 8 hours.
            act_dates = {r["shanghai_date"] for r in act_rows}
            completed = sum(1 for s in sessions if s["date"] in act_dates)
            planned = len(sessions)
            if planned > 0:
                rates.append(completed / planned)
    finally:
        plan_store.close()

    return rates


@router.get("/api/{user}/weeks/{folder}/review")
def get_week_review(user: str, folder: str):
    """Aggregate weekly review data for D9 screen."""
    dates = parse_week_dates(folder)
    if not dates:
        raise HTTPException(status_code=400, detail="Invalid folder")

    date_from, date_to = dates

    db = get_db(user)
    plan_store = get_plan_state_store(user)

    try:
        # ── 1. Actual activities this week ────────────────────────────────
        act_rows = db.query(
            f"""SELECT label_id, name, sport_type, date,
                      distance_m, duration_s, avg_pace_s_km, avg_hr
               FROM activities
               WHERE {SHANGHAI_DAY_SQL} BETWEEN ? AND ?
               ORDER BY date ASC, label_id ASC""",
            (date_from, date_to),
        )
        activities = [dict(r) for r in act_rows]

        run_acts = [
            a for a in activities if a.get("sport_type") in _RUN_SPORT_TYPES
        ]
        total_distance_km = round(
            sum(a.get("distance_m") or 0 for a in run_acts), 2
        )
        total_duration_sec = int(sum(a.get("duration_s") or 0 for a in run_acts))

        # ── 2. Planned sessions ───────────────────────────────────────────
        planned_sessions = plan_store.get_planned_sessions(week_folder=folder)

        total_planned = len(planned_sessions)

        # Map date -> list of actual activities for matching
        acts_by_date: dict[str, list[dict]] = {}
        for a in activities:
            d = (a.get("date") or "")[:10]
            acts_by_date.setdefault(d, []).append(a)

        # ── 3. Feedback lookup ────────────────────────────────────────────
        feedback_by_label: dict[str, dict] = {}
        for a in activities:
            row = db.get_activity_feedback(a["label_id"])
            if row:
                rd = dict(row)
                tags = rd.get("mood_tags")
                if isinstance(tags, str):
                    try:
                        rd["mood_tags"] = json.loads(tags)
                    except (ValueError, TypeError):
                        rd["mood_tags"] = []
                feedback_by_label[a["label_id"]] = rd

        # ── 4. Build session list ─────────────────────────────────────────
        sessions_payload: list[dict] = []
        completed_count = 0
        rpe_values: list[float] = []

        for ps in planned_sessions:
            ps_date = ps["date"]
            ps_kind = ps["kind"] or "run"
            ps_dist = ps["total_distance_m"]

            # Match: find the first actual run on the same date (simple heuristic).
            day_acts = acts_by_date.get(ps_date, [])
            matched_act: dict | None = None
            if ps_kind in ("run", "strength"):
                # For run sessions, match run-sport activities; for strength, anything else
                if ps_kind == "run":
                    matched_act = next(
                        (a for a in day_acts if a.get("sport_type") in _RUN_SPORT_TYPES),
                        None,
                    )
                else:
                    matched_act = next(
                        (a for a in day_acts if a.get("sport_type") not in _RUN_SPORT_TYPES),
                        None,
                    )
            elif day_acts:
                matched_act = day_acts[0]

            completed = matched_act is not None
            if completed:
                completed_count += 1

            fb = feedback_by_label.get(matched_act["label_id"]) if matched_act else None
            rpe = fb["rpe"] if fb else None
            mood_tags = fb["mood_tags"] if fb else None
            if rpe is not None:
                rpe_values.append(float(rpe))

            actual_dist = matched_act.get("distance_m") if matched_act else None
            actual_dur = matched_act.get("duration_s") if matched_act else None
            actual_hr = matched_act.get("avg_hr") if matched_act else None

            adherence_pct: int | None = None
            if completed and ps_dist and actual_dist and ps_dist > 0:
                adherence_pct = round(actual_dist / ps_dist * 100)

            sessions_payload.append({
                "date": ps_date,
                "session_index": ps["session_index"],
                "planned_summary": ps["summary"] or "",
                "planned_kind": ps_kind,
                "planned_distance_m": ps_dist,
                "completed": completed,
                "actual_label_id": matched_act["label_id"] if matched_act else None,
                "actual_distance_m": actual_dist,
                "actual_duration_sec": actual_dur,
                "actual_avg_hr": actual_hr,
                "rpe": rpe,
                "mood_tags": mood_tags,
                "adherence_pct": adherence_pct,
            })

        # Strength session count
        strength_completed = sum(
            1 for s in sessions_payload
            if s["planned_kind"] == "strength" and s["completed"]
        )

        completion_rate: float | None = (
            completed_count / total_planned if total_planned > 0 else None
        )
        avg_rpe: float | None = (
            round(sum(rpe_values) / len(rpe_values), 1) if rpe_values else None
        )

        summary = {
            "total_distance_km": total_distance_km,
            "total_duration_sec": total_duration_sec,
            "total_sessions_planned": total_planned,
            "total_sessions_completed": completed_count,
            "completion_rate": completion_rate,
            "strength_sessions_completed": strength_completed,
            "avg_rpe": avg_rpe,
        }

        # ── 5. TSB series (7 days) ────────────────────────────────────────
        health_rows = db.query(
            """SELECT date, ati, cti
               FROM daily_health
               WHERE date >= ? AND date <= ?
               ORDER BY date ASC""",
            (date_from, date_to),
        )
        tsb_series: list[dict] = []
        for r in health_rows:
            ati = r["ati"] or 0.0
            cti = r["cti"] or 0.0
            tsb_series.append({
                "date": r["date"],
                "tsb": round(cti - ati, 1),
                "ati": round(ati, 1),
                "cti": round(cti, 1),
            })

        # ── 6. Activity highlights (up to 3, latest first, with commentary) ──
        commentary_rows = db.query(
            f"""SELECT a.label_id, a.date,
                      date(datetime(a.date, '+8 hours')) AS shanghai_date,
                      a.name, ac.commentary
               FROM activities a
               INNER JOIN activity_commentary ac ON ac.label_id = a.label_id
               WHERE {SHANGHAI_DAY_SQL} BETWEEN ? AND ?
               ORDER BY a.date DESC, a.label_id DESC
               LIMIT 3""",
            (date_from, date_to),
        )
        activity_highlights = []
        for r in commentary_rows:
            commentary = r["commentary"] or ""
            excerpt = commentary[:80] if len(commentary) > 80 else commentary
            activity_highlights.append({
                "label_id": r["label_id"],
                "date": r["shanghai_date"] or "",
                "name": r["name"] or "",
                "commentary_excerpt": excerpt,
            })

        # ── 7. Insights ───────────────────────────────────────────────────
        prior_rates = _completion_rate_history(user, folder, n=4)
        insights_raw = generate_insights(summary, tsb_series, prior_rates)
        insights = [
            {"type": i.type, "level": i.level, "text": i.text}
            for i in insights_raw
        ]

        # ── 8. Next week preview ──────────────────────────────────────────
        next_folder = _next_week_folder(folder, user)
        next_week_preview: dict | None = None
        if next_folder:
            next_dates = parse_week_dates(next_folder)
            next_sessions = plan_store.get_planned_sessions(week_folder=next_folder)
            next_plan_row = plan_store.get_weekly_plan_row(next_folder)

            plan_title: str | None = None
            if next_plan_row:
                first_line = (next_plan_row["content_md"] or "").splitlines()
                plan_title = first_line[0].lstrip("# ").strip() if first_line else None

            if next_sessions or next_plan_row:
                total_next_dist = sum(
                    (s["total_distance_m"] or 0) for s in next_sessions
                ) / 1000.0

                # Key session: the session with the longest distance in the week
                key_session: str | None = None
                if next_sessions:
                    best = max(next_sessions, key=lambda s: s.get("total_distance_m") or 0)
                    key_session = best.get("summary") or None

                next_week_preview = {
                    "folder": next_folder,
                    "plan_title": plan_title,
                    "total_planned_distance_km": round(total_next_dist, 1),
                    "sessions_count": len(next_sessions),
                    "key_session_summary": key_session,
                }

    finally:
        plan_store.close()
        db.close()

    return {
        "folder": folder,
        "date_from": date_from,
        "date_to": date_to,
        "summary": summary,
        "tsb_series": tsb_series,
        "sessions": sessions_payload,
        "activity_highlights": activity_highlights,
        "insights": insights,
        "next_week_preview": next_week_preview,
    }
