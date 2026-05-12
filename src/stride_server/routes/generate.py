"""Single-week plan generation + whole-week push endpoints (rule engine, no LLM).

POST /api/{user}/plan/weeks/generate   — generate a rule-based weekly plan
POST /api/{user}/plan/{folder}/push    — push all pushable sessions to watch
"""

from __future__ import annotations

import json
import logging
import time
from datetime import date as date_cls, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from stride_core.plan_spec import SessionKind
from stride_core.source import DataSource
from stride_core.timefmt import SHANGHAI_DAY_SQL

from ..deps import get_db, get_plan_state_store, get_source_for_user, parse_week_dates
from ..week_generator import generate_week_plan, week_folder

# Imported at module level so tests can patch it via
# ``patch("stride_server.routes.generate.push_single_session")``.
# The lazy-import inside the route body would require patching the plan module
# directly AND is incompatible with patch's attribute-lookup mechanism.
# We use TYPE_CHECKING to keep the import conditional at type-check time while
# still making it unconditional at runtime.
from stride_server.routes.plan import push_single_session  # noqa: E402

logger = logging.getLogger(__name__)

router = APIRouter()

_GENERATED_BY = "rule-engine-v1"


# ── Request / response models ─────────────────────────────────────────────────


class GenerateWeekRequest(BaseModel):
    week_start: str          # YYYY-MM-DD, must be a Monday
    source: str = "manual"   # "manual" | "auto"
    base_distance_km: float | None = None


# ── Helpers ───────────────────────────────────────────────────────────────────


def _folder_exists(plan_store, folder: str) -> bool:
    """Return True if this week already has a weekly_plan row OR planned_session rows."""
    row = plan_store.get_weekly_plan_row(folder)
    if row is not None:
        return True
    sessions = plan_store.get_planned_sessions(week_folder=folder)
    return len(sessions) > 0


def _get_last_week_summary(db, plan_store, week_start: date_cls) -> dict | None:
    """Query the previous week for completion rate and avg RPE.

    Returns a dict with:
      ``completed_sessions``, ``total_sessions``,
      ``total_distance_km``, ``avg_rpe``
    or None when no data exists for that week.
    """
    prev_start = week_start - timedelta(days=7)
    prev_end = prev_start + timedelta(days=6)
    prev_folder = week_folder(prev_start)

    # Total planned sessions for prev week
    planned_rows = plan_store.get_planned_sessions(week_folder=prev_folder)
    if not planned_rows:
        return None

    total_sessions = len(planned_rows)

    # Sum up completed sessions from activities in that week.
    # activities.date is UTC ISO; compare in the Shanghai calendar via
    # SHANGHAI_DAY_SQL so a 00:30 Shanghai workout (16:30 UTC the previous
    # day) lands on the correct planned-session date.
    date_from = prev_start.isoformat()
    date_to = prev_end.isoformat()
    activity_rows = db.query(
        f"""SELECT date, distance_m, avg_pace_s_km
           FROM activities
           WHERE {SHANGHAI_DAY_SQL} BETWEEN ? AND ?
           ORDER BY date""",
        (date_from, date_to),
    )

    # Collect planned run distances for last week
    run_distances = [
        float(r["total_distance_m"] or 0)
        for r in planned_rows
        if r["kind"] == SessionKind.RUN.value
    ]
    total_planned_km = sum(run_distances) / 1000.0

    # Count activity dates that overlap with planned-run dates
    planned_run_dates = {
        r["date"] for r in planned_rows if r["kind"] == SessionKind.RUN.value
    }
    completed = 0
    actual_distance_m = 0.0
    for act in activity_rows:
        raw = str(act["date"])
        # activities.date may be compact YYYYMMDD; normalise to ISO YYYY-MM-DD.
        if len(raw) == 8 and raw.isdigit():
            act_date = f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"
        else:
            act_date = raw[:10]
        if act_date in planned_run_dates:
            completed += 1
            actual_distance_m += float(act["distance_m"] or 0)

    if completed == 0 and total_sessions == 0:
        return None

    # Use the *planned* base, not the actual mileage. Otherwise an
    # under-completed week (e.g. 16km actual vs 40km planned) would shrink
    # next week's target dramatically — punishing the user twice.
    total_distance_km = total_planned_km

    return {
        "completed_sessions": completed,
        "total_sessions": total_sessions,
        "total_distance_km": total_distance_km,
        "avg_rpe": None,  # RPE not stored per planned-session; future: pull from activity_feedback
    }


def _write_plan(plan_store, folder: str, weekly_plan) -> None:
    """Persist WeeklyPlan via apply_weekly_plan_atomic."""
    from stride_core.plan_spec import PlannedNutrition

    # Build a minimal markdown representation
    lines = [f"# 训练计划 {folder}", ""]
    lines.append(f"> 由{_GENERATED_BY}自动生成。")
    lines.append("")
    for s in weekly_plan.sessions:
        lines.append(f"- **{s.date}** ({s.kind.value}): {s.summary}")
    content_md = "\n".join(lines)

    plan_store.apply_weekly_plan_atomic(
        folder,
        content_md,
        generated_by=_GENERATED_BY,
        sessions=list(weekly_plan.sessions),
        nutrition=list(weekly_plan.nutrition),
        structured_status="authored",
        structured_source="authored",
        parsed_from_md_hash=None,
    )


# ── Route ─────────────────────────────────────────────────────────────────────


@router.post("/api/{user}/plan/weeks/generate")
def generate_week(
    user: str,
    body: GenerateWeekRequest,
    force: bool = Query(default=False),
) -> dict[str, Any]:
    """Generate a rule-based structured weekly plan.

    - 400 when week_start is not a Monday.
    - 409 when the week already exists (unless ?force=true).
    - On force=true: deletes existing planned_session rows then re-generates.
    """
    # ── Validate week_start ──────────────────────────────────────────────────
    try:
        week_start = date_cls.fromisoformat(body.week_start)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="week_start must be ISO YYYY-MM-DD",
        )
    if week_start.weekday() != 0:
        raise HTTPException(
            status_code=400,
            detail=f"week_start must be a Monday (weekday=0); got weekday={week_start.weekday()}",
        )

    folder = week_folder(week_start)
    # Verify folder string is valid (week_folder always produces valid strings,
    # but parse_week_dates is the canonical validator used by other routes).
    if not parse_week_dates(folder):
        raise HTTPException(status_code=500, detail="Internal: invalid folder generated")

    plan_store = get_plan_state_store(user)
    db = get_db(user)

    try:
        # ── Conflict check ───────────────────────────────────────────────────
        if _folder_exists(plan_store, folder):
            if not force:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "error": "week_already_exists",
                        "folder": folder,
                        "hint": "Pass ?force=true to overwrite the existing plan",
                    },
                )
            # force=true: wipe existing planned_session rows for this week.
            # apply_weekly_plan_atomic with sessions=[] deletes them atomically.
            logger.info("generate_week: force overwrite folder=%s user=%s", folder, user)

        # ── Compute last-week summary ────────────────────────────────────────
        last_week_summary = _get_last_week_summary(db, plan_store, week_start)

        # ── Generate ─────────────────────────────────────────────────────────
        weekly_plan, base_km = generate_week_plan(
            user_id=user,
            week_start=week_start,
            base_distance_km=body.base_distance_km,
            last_week_summary=last_week_summary,
        )

        # ── Persist ──────────────────────────────────────────────────────────
        _write_plan(plan_store, folder, weekly_plan)

    finally:
        plan_store.close()
        db.close()

    # ── Build response ───────────────────────────────────────────────────────
    # ``total_distance_km`` reports the *target* base (user-facing weekly mileage),
    # not the sum of allocated session distances (which is ~87% of base by
    # design — rest day + strength don't carry km).
    total_distance_km = round(base_km, 1)

    sessions_payload = []
    for s in weekly_plan.sessions:
        entry: dict[str, Any] = {
            "date": s.date,
            "session_index": s.session_index,
            "kind": s.kind.value,
            "summary": s.summary,
        }
        if s.total_distance_m is not None:
            entry["total_distance_m"] = s.total_distance_m
        if s.total_duration_s is not None:
            entry["total_duration_s"] = s.total_duration_s
        if s.notes_md:
            # Extract target_pace and target_hr_zone from notes/summary
            pass
        # Surface pace/hr hints from the generator constants
        if s.kind == SessionKind.RUN:
            summary = s.summary
            # Extract pace hint from parentheses if present
            import re
            pace_match = re.search(r"(\d+:\d+-\d+:\d+/km)", summary)
            if pace_match:
                entry["target_pace"] = pace_match.group(1)
            hr_match = re.search(r"目标心率：(Z\d+)", s.notes_md or "")
            if hr_match:
                entry["target_hr_zone"] = hr_match.group(1)
        sessions_payload.append(entry)

    return {
        "folder": folder,
        "week_start": body.week_start,
        "total_distance_km": total_distance_km,
        "sessions_count": len(weekly_plan.sessions),
        "sessions": sessions_payload,
        "source": body.source,
    }


# ── Whole-week push ───────────────────────────────────────────────────────────

# Rate-limit between consecutive COROS API calls (R4 in M2 plan)
_PUSH_INTERVAL_S = 0.3


@router.post("/api/{user}/plan/{folder}/push")
def push_week(
    user: str,
    folder: str,
    dry_run: bool = Query(default=False),
    source: DataSource = Depends(get_source_for_user),
) -> dict[str, Any]:
    """Push all pushable sessions for a week to the user's watch.

    - 404 when the folder has no planned_session rows.
    - 400 when the folder path is invalid.
    - Returns a results list with per-session success/failure regardless of
      individual errors — one failure never blocks the rest.
    - ``?dry_run=true``: build the results list but do NOT call the push
      adapter; ``success_count`` is always 0, ``failed_count`` always 0,
      results all have ``success=null`` (preview mode).
    """
    if not parse_week_dates(folder):
        raise HTTPException(status_code=400, detail="Invalid folder format")

    plan_store = get_plan_state_store(user)
    db = get_db(user)
    try:
        sessions = plan_store.get_planned_sessions(week_folder=folder)
    finally:
        plan_store.close()
        db.close()

    if not sessions:
        raise HTTPException(
            status_code=404,
            detail=f"No planned sessions found for folder {folder!r}",
        )

    # Filter to pushable session kinds only (exclude rest/custom without spec)
    pushable = [
        s for s in sessions
        if s["kind"] in (SessionKind.RUN.value, SessionKind.STRENGTH.value)
        and s["spec_json"]
    ]

    total = len(pushable)

    if dry_run:
        # Preview mode: return what would be pushed, no actual API calls
        preview_items = [
            {
                "session_id": s["id"],
                "date": s["date"],
                "session_index": s["session_index"],
                "kind": s["kind"],
                "summary": s["summary"] or "",
                "success": None,
                "scheduled_workout_id": None,
                "error": None,
            }
            for s in pushable
        ]
        return {
            "ok": True,
            "folder": folder,
            "total": total,
            "success_count": 0,
            "failed_count": 0,
            "dry_run": True,
            "results": preview_items,
        }

    # Real push: iterate sessions, capture per-item results

    results: list[dict[str, Any]] = []
    for i, session in enumerate(pushable):
        # Rate-limit: sleep between pushes (not before the first one)
        if i > 0:
            time.sleep(_PUSH_INTERVAL_S)

        db2 = get_db(user)
        plan_store2 = get_plan_state_store(user)
        try:
            result = push_single_session(
                user,
                session["date"],
                session["session_index"],
                source,
                db2,
                plan_store2,
            )
        finally:
            plan_store2.close()
            db2.close()

        results.append(result)

    success_count = sum(1 for r in results if r["success"])
    failed_count = sum(1 for r in results if not r["success"])

    return {
        "ok": True,
        "folder": folder,
        "total": total,
        "success_count": success_count,
        "failed_count": failed_count,
        "dry_run": False,
        "results": results,
    }
