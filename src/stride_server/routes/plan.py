"""Structured weekly-plan API.

Two routers live here:

- ``router`` — public endpoints (calendar / today / push / reparse). Mounted in
  ``app.py`` behind ``protected_user`` (Bearer + path-user verification).

- ``internal_router`` — webhook endpoints called by trusted infrastructure
  (e.g. the ``sync-data.yml`` GitHub Action). Mounted **separately** so it
  does NOT inherit ``require_bearer``; instead each route declares
  ``Depends(require_internal_token)``. Path is ``/internal/...`` (NOT
  ``/api/internal/...``) so future bearer-prefix middleware on ``/api/*``
  cannot accidentally catch it.
"""

from __future__ import annotations

import json
import logging
import os
import secrets as _secrets
from datetime import date as date_cls, datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, status

# Reject huge plan markdowns *before* sending them to the LLM. Prompt-injection
# guardrail + cost cap; 64 KiB comfortably accommodates a multi-week plan with
# nutrition tables and detailed daily notes (we observe ~6-12 KiB in practice).
_MAX_PLAN_MD_BYTES = 64 * 1024

from stride_core.db import Database
from stride_core.plan_spec import SessionKind
from stride_core.source import Capability, DataSource, FeatureNotSupported
from stride_core.workout_spec import NormalizedRunWorkout

from ..coach_agent.agent import apply_weekly_plan, run_agent
from ..content_store import read_text as content_read_text
from ..deps import format_duration, get_db, get_source_for_user, parse_week_dates

logger = logging.getLogger(__name__)

router = APIRouter()
internal_router = APIRouter()


# ─────────────────────────────────────────────────────────────────────────────
# Internal-token dependency
# ─────────────────────────────────────────────────────────────────────────────


def require_internal_token(
    x_internal_token: str | None = Header(default=None, alias="X-Internal-Token"),
) -> None:
    """Validate ``X-Internal-Token`` against ``STRIDE_INTERNAL_TOKEN``.

    Returns 401 when the env var is unset (we won't accept *any* token if the
    server has no expected value), the header is missing, or the values do
    not match. Mirrors the ``Bearer`` dep's failure shape so clients see a
    consistent error envelope.
    """
    expected = os.environ.get("STRIDE_INTERNAL_TOKEN")
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Internal token not configured on server",
        )
    # Use constant-time comparison to avoid leaking the expected token via
    # response-time differences (str ``==`` short-circuits on first mismatch).
    if not x_internal_token or not _secrets.compare_digest(x_internal_token, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid internal token",
        )


# ─────────────────────────────────────────────────────────────────────────────
# Row → JSON helpers (keep response shape stable + minimal)
# ─────────────────────────────────────────────────────────────────────────────


def _serialize_session(row: Any) -> dict[str, Any]:
    spec_json = row["spec_json"]
    spec = json.loads(spec_json) if spec_json else None
    pushable = row["kind"] in (SessionKind.RUN.value, SessionKind.STRENGTH.value) and spec is not None
    return {
        "id": row["id"],
        "date": row["date"],
        "session_index": row["session_index"],
        "kind": row["kind"],
        "summary": row["summary"],
        "spec": spec,
        "notes_md": row["notes_md"],
        "total_distance_m": row["total_distance_m"],
        "total_duration_s": row["total_duration_s"],
        "scheduled_workout_id": row["scheduled_workout_id"],
        "pushable": pushable,
    }


def _serialize_nutrition(row: Any) -> dict[str, Any]:
    meals_json = row["meals_json"]
    return {
        "date": row["date"],
        "kcal_target": row["kcal_target"],
        "carbs_g": row["carbs_g"],
        "protein_g": row["protein_g"],
        "fat_g": row["fat_g"],
        "water_ml": row["water_ml"],
        "meals": json.loads(meals_json) if meals_json else [],
        "notes_md": row["notes_md"],
    }


def _shanghai_today_iso() -> str:
    """Local Shanghai date — DB rows use Asia/Shanghai semantics (see CLAUDE.md)."""
    return (datetime.now(timezone.utc) + timedelta(hours=8)).date().isoformat()


def _planned_vs_actual(db: Database, day: str) -> list[dict[str, Any]]:
    """Cross-reference planned sessions for ``day`` with synced activities.

    Activities are matched by date prefix only. We expose a tiny shape
    (planned summary + per-activity actuals) so the frontend can colour-code
    adherence without the server enforcing a single rubric.
    """
    sessions = db.get_planned_sessions(date_from=day, date_to=day)
    rows = db.query(
        """SELECT label_id, name, sport_name, sport, date,
            distance_m, duration_s, avg_pace_s_km, avg_hr, train_kind, sport_type
        FROM activities WHERE date >= ? AND date < ?
        ORDER BY date ASC, label_id ASC""",
        (day, day + "T99"),
    )
    activities = [dict(r) for r in rows]

    out: list[dict[str, Any]] = []
    for s in sessions:
        # Match heuristic: kind=run pairs with running activities (sport='run'
        # if normalized, else sport_type==100); kind=strength with strength
        # activities (sport_type==4). Anything else: leave actual=None.
        actual = None
        if s["kind"] == SessionKind.RUN.value:
            for a in activities:
                if a.get("sport") == "run" or a.get("sport_type") == 100:
                    actual = a
                    break
        elif s["kind"] == SessionKind.STRENGTH.value:
            for a in activities:
                if a.get("sport") == "strength" or a.get("sport_type") == 4:
                    actual = a
                    break
        out.append({
            "planned": _serialize_session(s),
            "actual": actual,
        })
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Public routes
# ─────────────────────────────────────────────────────────────────────────────


_MAX_DAYS_RANGE = 90


@router.get("/api/{user}/plan/days")
def get_plan_days(
    user: str,
    date_from: str = Query(..., alias="from"),
    date_to: str = Query(..., alias="to"),
):
    """Return planned sessions + nutrition for an inclusive ``[from, to]`` range.

    Range capped at 90 days. Days with no data come back as empty entries so
    the calendar can render a contiguous grid without client-side gap filling.
    """
    try:
        d_from = date_cls.fromisoformat(date_from)
        d_to = date_cls.fromisoformat(date_to)
    except ValueError:
        raise HTTPException(status_code=400, detail="from/to must be ISO YYYY-MM-DD")
    if d_to < d_from:
        raise HTTPException(status_code=400, detail="to must be >= from")
    if (d_to - d_from).days >= _MAX_DAYS_RANGE:
        raise HTTPException(
            status_code=400,
            detail=f"date range cannot exceed {_MAX_DAYS_RANGE} days",
        )

    db = get_db(user)
    try:
        session_rows = db.get_planned_sessions(date_from=date_from, date_to=date_to)
        nutrition_rows = db.get_planned_nutrition(date_from=date_from, date_to=date_to)
    finally:
        db.close()

    by_date: dict[str, dict[str, Any]] = {}
    cur = d_from
    while cur <= d_to:
        iso = cur.isoformat()
        by_date[iso] = {"date": iso, "sessions": [], "nutrition": None}
        cur += timedelta(days=1)
    for r in session_rows:
        by_date[r["date"]]["sessions"].append(_serialize_session(r))
    for r in nutrition_rows:
        by_date[r["date"]]["nutrition"] = _serialize_nutrition(r)

    return {"days": [by_date[k] for k in sorted(by_date.keys())]}


@router.get("/api/{user}/plan/today")
def get_plan_today(user: str):
    today = _shanghai_today_iso()
    db = get_db(user)
    try:
        session_rows = db.get_planned_sessions(date_from=today, date_to=today)
        nutrition_rows = db.get_planned_nutrition(date_from=today, date_to=today)
        planned_vs_actual = _planned_vs_actual(db, today)
    finally:
        db.close()
    return {
        "date": today,
        "sessions": [_serialize_session(r) for r in session_rows],
        "nutrition": _serialize_nutrition(nutrition_rows[0]) if nutrition_rows else None,
        "planned_vs_actual": planned_vs_actual,
    }


def _push_guard_or_raise(db: Database, week_folder: str) -> None:
    """409 unless the week's structured layer is ``fresh``.

    ``backfilled`` is intentionally rejected: historical re-parses can hallucinate
    interval structures that should be human-reviewed before going to the watch.
    """
    row = db.get_weekly_plan_row(week_folder)
    structured_status = None
    if row is not None:
        try:
            structured_status = row["structured_status"]
        except (IndexError, KeyError):
            structured_status = None
    if structured_status != "fresh":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "structured plan not fresh, click 重新解析 first",
                "structured_status": structured_status,
            },
        )


def _week_folder_for_date(db: Database, day: str) -> str | None:
    """Best-effort: locate the week_folder a planned session lives under by
    walking the ``weekly_plan`` table. We don't store week_folder on the
    session row directly via the public API surface, but the DB does — so we
    reuse that.
    """
    row = db.query(
        "SELECT week_folder FROM planned_session WHERE date = ? LIMIT 1", (day,)
    )
    if row:
        return row[0]["week_folder"]
    return None


@router.post("/api/{user}/plan/sessions/{date}/{session_index}/push")
def push_planned_session(
    user: str,
    date: str,
    session_index: int,
    source: DataSource = Depends(get_source_for_user),
):
    """Push a single planned RUN session to the user's watch.

    Path:
      - 404 when the planned_session row doesn't exist
      - 409 when the parent week's ``structured_status != 'fresh'`` (e.g.
        ``backfilled`` or ``parse_failed``)
      - 400 when the session is not RUN, has no spec, or the provider lacks
        ``PUSH_RUN_WORKOUT``
      - 400 when re-pushing requires deletion but the provider lacks
        ``DELETE_WORKOUT``
      - 502 when the upstream watch service rejects the push

    On success: a new ``scheduled_workout`` row is created with
    ``status='pushed'``; any prior row attached via FK is marked
    ``status='superseded'`` after its watch-side template is removed.
    """
    db = get_db(user)
    try:
        session_row = db.get_planned_session_by_date_index(date, session_index)
        if session_row is None:
            raise HTTPException(status_code=404, detail="Planned session not found")

        if session_row["kind"] != SessionKind.RUN.value:
            raise HTTPException(
                status_code=400,
                detail=f"Push only supports kind=run; got {session_row['kind']!r}",
            )
        if not session_row["spec_json"]:
            raise HTTPException(
                status_code=400,
                detail="Planned session has no spec (aspirational); cannot push",
            )

        week_folder = session_row["week_folder"]
        _push_guard_or_raise(db, week_folder)

        if Capability.PUSH_RUN_WORKOUT not in source.info.capabilities:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Provider {source.info.name!r} does not support pushing run workouts"
                ),
            )

        try:
            workout = NormalizedRunWorkout.from_dict(json.loads(session_row["spec_json"]))
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Stored spec is not a valid NormalizedRunWorkout: {exc}",
            )

        # Re-push: detach prior scheduled_workout. We delete from the watch
        # FIRST (the only externally observable side-effect that *must*
        # happen before the new push), but defer the local
        # ``status='superseded'`` UPDATE until after the new push succeeds.
        # Marking the old row superseded earlier would strand it on a 502
        # with no replacement row pointing at the planned session.
        prior_id = session_row["scheduled_workout_id"]
        prior_was_pushed = False
        if prior_id is not None:
            prior = db.get_scheduled_workout(prior_id)
            if prior is not None and prior["status"] == "pushed":
                prior_was_pushed = True
                if Capability.DELETE_WORKOUT not in source.info.capabilities:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Provider {source.info.name!r} does not support deletion; "
                            "remove the prior workout from the watch manually before re-pushing"
                        ),
                    )
                try:
                    source.delete_scheduled_workout(user, prior["date"])
                except FeatureNotSupported:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Provider {source.info.name!r} does not support deletion; "
                            "remove the prior workout from the watch manually before re-pushing"
                        ),
                    )
                except Exception:
                    logger.exception(
                        "delete prior scheduled_workout id=%s failed", prior_id,
                    )
                    raise HTTPException(
                        status_code=502,
                        detail="Could not remove prior workout from watch service",
                    )

        try:
            provider_workout_id = source.push_run_workout(user, workout)
        except FeatureNotSupported:
            raise HTTPException(
                status_code=400,
                detail=f"Provider {source.info.name!r} does not support pushing run workouts",
            )
        except Exception:
            logger.exception(
                "push_run_workout failed user=%s provider=%s", user, source.info.name,
            )
            # The watch-side delete (if any) already ran, but the local DB
            # state for the prior row is intact — UI will still show it as
            # 'pushed' until the user successfully re-pushes. That's a
            # lesser evil than stranding a 'superseded' row with no
            # replacement.
            raise HTTPException(
                status_code=502,
                detail="Could not push workout to watch service",
            )

        # Push succeeded — atomically commit the local state transition:
        # insert new scheduled_workout row → mark pushed → mark old row
        # superseded → back-stamp planned_session.scheduled_workout_id. The
        # ``with db._conn:`` block uses sqlite3's connection-as-context-manager
        # to commit on success and rollback on exception.
        with db._conn:
            cur = db._conn.execute(
                """INSERT INTO scheduled_workout
                   (date, kind, name, spec_json, status, provider,
                    provider_workout_id, pushed_at)
                   VALUES (?, ?, ?, ?, 'pushed', ?, ?, datetime('now'))""",
                (
                    date, "run", workout.name, session_row["spec_json"],
                    source.info.name, provider_workout_id,
                ),
            )
            new_sw_id = cur.lastrowid
            if prior_was_pushed:
                db._conn.execute(
                    "UPDATE scheduled_workout SET status='superseded', "
                    "updated_at=datetime('now') WHERE id=?",
                    (prior_id,),
                )
            db._conn.execute(
                "UPDATE planned_session SET scheduled_workout_id=?, "
                "updated_at=datetime('now') WHERE id=?",
                (new_sw_id, session_row["id"]),
            )

        return {
            "ok": True,
            "planned_session_id": session_row["id"],
            "scheduled_workout_id": new_sw_id,
            "provider": source.info.name,
            "provider_workout_id": provider_workout_id,
        }
    finally:
        db.close()


@router.post("/api/{user}/plan/reparse")
def reparse_plan(
    user: str,
    folder: str = Query(...),
):
    """Re-run the LLM reverse parser on the stored markdown for a week.

    Used by the UI's "重新解析计划" button. Reads the canonical markdown from
    ``weekly_plan.content_md`` (or the on-disk plan.md as fallback when the
    DB row isn't there yet), invokes ``run_agent(task='parse_plan')``, and
    writes the structured layer + ``structured_status`` accordingly.
    """
    if not parse_week_dates(folder):
        raise HTTPException(status_code=400, detail="Invalid folder")

    db = get_db(user)
    try:
        row = db.get_weekly_plan_row(folder)
        existing_generated_by = row["generated_by"] if row else None
        content_md = row["content_md"] if row else ""
    finally:
        db.close()

    # Fall back to the on-disk plan.md when the DB row is empty. Historical
    # weeks were authored by hand + git-pushed via sync-data.yml, never went
    # through `apply_weekly_plan`, so weekly_plan.content_md is NULL for
    # them. Reading from disk lets the user trigger reparse on those weeks
    # without first having to re-import each one through the coach CLI.
    if not content_md:
        disk_md = content_read_text(f"{user}/logs/{folder}/plan.md")
        if disk_md:
            content_md = disk_md
    if not content_md:
        raise HTTPException(
            status_code=404,
            detail=f"No stored plan for week {folder!r}; nothing to reparse",
        )

    if len(content_md.encode("utf-8")) > _MAX_PLAN_MD_BYTES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Plan markdown exceeds {_MAX_PLAN_MD_BYTES} byte limit; "
                "trim the file before re-parsing"
            ),
        )

    result = run_agent(
        user, task="parse_plan", user_message="reparse",
        folder=folder, md_text=content_md, sync_before=False,
    )
    apply_weekly_plan(
        user, folder, content_md,
        generated_by=existing_generated_by,
        structured=result.structured,
        structured_source="fresh",
    )
    return {
        "ok": True,
        "folder": folder,
        "structured_status": "fresh" if result.structured is not None else "parse_failed",
        "parse_error": result.parse_error,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Internal route — webhook from sync-data.yml
# ─────────────────────────────────────────────────────────────────────────────


@internal_router.post("/internal/plan/reparse")
def internal_reparse_plan(
    user: str = Query(...),
    folder: str = Query(...),
    _token: None = Depends(require_internal_token),
):
    """Trusted webhook used by ``sync-data.yml`` after pushing a fresh plan.md
    to Azure Files. Re-uses the same reverse-parser path as the UI button so
    we have one canonical reparse code path.

    Atomicity guard: when the stored markdown's sha256 matches the previous
    ``parsed_from_md_hash`` already on the row, we skip the LLM call and
    return ``noop=True``. This makes the webhook idempotent — a re-run of the
    same git push (or a manual workflow_dispatch) does not waste tokens.
    Azure Files SMB writes are not atomic, so a partial read on the very first
    upload can yield a wrong hash; the next webhook trigger reads the settled
    file and corrects it.
    """
    import hashlib

    if not parse_week_dates(folder):
        raise HTTPException(status_code=400, detail="Invalid folder")

    db = get_db(user)
    try:
        row = db.get_weekly_plan_row(folder)
        existing_generated_by = row["generated_by"] if row else None
        content_md = row["content_md"] if row else ""
        prior_hash = None
        prior_status = None
        if row is not None:
            try:
                prior_hash = row["parsed_from_md_hash"]
                prior_status = row["structured_status"]
            except (IndexError, KeyError):
                pass
    finally:
        db.close()

    # Same disk fallback as the public reparse route — sync-data.yml uploads
    # plan.md to Azure Files but doesn't write the DB row, so the first
    # webhook for a new week reads from disk.
    if not content_md:
        disk_md = content_read_text(f"{user}/logs/{folder}/plan.md")
        if disk_md:
            content_md = disk_md
    if not content_md:
        raise HTTPException(
            status_code=404,
            detail=f"No stored plan for week {folder!r}",
        )

    md_hash = hashlib.sha256(content_md.encode("utf-8")).hexdigest()
    if (
        prior_hash == md_hash
        and prior_status == "fresh"
    ):
        return {
            "ok": True,
            "noop": True,
            "user": user,
            "folder": folder,
            "structured_status": prior_status,
            "parse_error": None,
        }

    if len(content_md.encode("utf-8")) > _MAX_PLAN_MD_BYTES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Plan markdown exceeds {_MAX_PLAN_MD_BYTES} byte limit; "
                "trim the file before re-parsing"
            ),
        )

    result = run_agent(
        user, task="parse_plan", user_message="webhook reparse",
        folder=folder, md_text=content_md, sync_before=False,
    )
    apply_weekly_plan(
        user, folder, content_md,
        generated_by=existing_generated_by,
        structured=result.structured,
        structured_source="fresh",
    )
    return {
        "ok": True,
        "noop": False,
        "user": user,
        "folder": folder,
        "structured_status": "fresh" if result.structured is not None else "parse_failed",
        "parse_error": result.parse_error,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Backwards-compat alias for `format_duration` import (keeps sloppy refactors
# from accidentally breaking imports — exported here as a convenience).
# ─────────────────────────────────────────────────────────────────────────────


__all__ = [
    "router",
    "internal_router",
    "require_internal_token",
    "format_duration",
]
