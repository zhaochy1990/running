"""Single-week plan generation + whole-week push endpoints (LLM-generated).

POST /api/{user}/plan/weeks/generate   — generate an LLM weekly plan
POST /api/{user}/plan/{folder}/push    — push all pushable sessions to watch
"""

from __future__ import annotations

import json
import logging
import time
from types import SimpleNamespace
from datetime import date as date_cls
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from stride_core.plan_spec import SessionKind
from stride_core.source import DataSource
from stride_core.timefmt import today_shanghai, week_folder
from stride_core.weekly_plan_proposal import is_supported_weekly_plan_generation
from ..deps import get_db, get_plan_state_store, get_source_for_user, parse_week_dates
from ..coach_runtime import get_generator_model
from ..weekly_plan_generator import (
    WeeklyPlanAlreadyExistsError,
    WeeklyPlanGenerationError,
    build_weekly_plan,
    get_last_week_summary,
)
from ..weekly_plan_store import get_weekly_plan_store, save_weekly_plan, session_api_id

# Imported at module level so tests can patch it via
# ``patch("stride_server.routes.generate.push_single_session")``.
# The lazy-import inside the route body would require patching the plan module
# directly AND is incompatible with patch's attribute-lookup mechanism.
# We use TYPE_CHECKING to keep the import conditional at type-check time while
# still making it unconditional at runtime.
from stride_server.routes.plan import push_single_session  # noqa: E402

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Request / response models ─────────────────────────────────────────────────


class GenerateWeekRequest(BaseModel):
    week_start: str          # YYYY-MM-DD, must be a Monday
    source: str = "manual"   # "manual" | "auto"
    base_distance_km: float | None = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_last_week_summary(user: str, db, week_start: date_cls) -> dict | None:
    """Compatibility wrapper around the reusable generation service."""
    return get_last_week_summary(
        user, db, week_start, plan_store=get_weekly_plan_store()
    )


def _write_plan(user: str, weekly_plan) -> None:
    save_weekly_plan(
        user, weekly_plan, generated_by=get_generator_model()
    )


def _legacy_row_to_session(row) -> SimpleNamespace:
    """Read-only identity view for legacy whole-week push enumeration."""
    kind = SessionKind(row["kind"])
    return SimpleNamespace(
        date=row["date"], session_index=row["session_index"], kind=kind,
        summary=row["summary"],
        total_distance_m=row["total_distance_m"],
        pushable=(
            kind in (SessionKind.RUN, SessionKind.STRENGTH)
            and bool(row["spec_json"])
        ),
    )


# ── Route ─────────────────────────────────────────────────────────────────────


@router.post("/api/{user}/plan/weeks/generate")
def generate_week(
    user: str,
    body: GenerateWeekRequest,
    force: bool = Query(default=False),
) -> dict[str, Any]:
    """Generate an LLM-authored structured weekly plan.

    - 400 when week_start is not a Monday.
    - 409 when the week already exists (unless ?force=true).
    - 502 when the LLM generator cannot produce a rule-valid week after retries.
    - On force=true: replaces the canonical WeeklyPlan for that week.
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
    if not is_supported_weekly_plan_generation(
        folder, today=today_shanghai()
    ):
        raise HTTPException(
            status_code=400,
            detail="Only the current and next Shanghai calendar weeks can be generated",
        )

    try:
        generated = build_weekly_plan(
            user_id=user,
            week_start=week_start,
            base_distance_km=body.base_distance_km,
            allow_existing=force,
        )
        weekly_plan = generated.plan
        if force:
            logger.info(
                "generate_week: force overwrite week_start=%s user=%s",
                week_start, user,
            )
        _write_plan(user, weekly_plan)
    except WeeklyPlanAlreadyExistsError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "week_already_exists",
                "folder": exc.folder,
                "hint": "Pass ?force=true to overwrite the existing plan",
            },
        ) from exc
    except WeeklyPlanGenerationError as exc:
        logger.warning(
            "generate_week: LLM generation failed week_start=%s user=%s: %s",
            week_start, user, exc,
        )
        raise HTTPException(
            status_code=502,
            detail={
                "error": "weekly_plan_generation_failed",
                "hint": "The plan generator could not produce a valid week; please retry.",
            },
        ) from exc

    # ── Build response ───────────────────────────────────────────────────────
    # ``total_distance_km`` reports the user-facing weekly running target.
    total_distance_km = generated.total_distance_km

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

    plan = get_weekly_plan_store().get_plan(user, folder)
    sessions = list(plan.sessions) if plan else []
    if not sessions:
        legacy = get_plan_state_store(user)
        try:
            sessions = [
                _legacy_row_to_session(row)
                for row in legacy.get_planned_sessions(week_folder=folder)
            ]
        finally:
            legacy.close()

    if not sessions:
        raise HTTPException(
            status_code=404,
            detail=f"No planned sessions found for folder {folder!r}",
        )

    # Filter to pushable session kinds only (exclude rest/custom without spec)
    pushable = [
        s for s in sessions
        if s.pushable
    ]

    total = len(pushable)

    if dry_run:
        # Preview mode: return what would be pushed, no actual API calls
        preview_items = [
            {
                "session_id": session_api_id(folder, s.date, s.session_index),
                "date": s.date,
                "session_index": s.session_index,
                "kind": s.kind.value,
                "summary": s.summary or "",
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
                user, session.date, session.session_index, source, db2, plan_store2
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
