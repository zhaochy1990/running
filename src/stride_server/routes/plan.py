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

import dataclasses
import json
import logging
import secrets as _secrets
from collections.abc import Iterator
from datetime import date as date_cls, timedelta
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, status

# Reject huge plan markdowns *before* sending them to the LLM. Prompt-injection
# guardrail + cost cap; 64 KiB comfortably accommodates a multi-week plan with
# nutrition tables and detailed daily notes (we observe ~6-12 KiB in practice).
_MAX_PLAN_MD_BYTES = 64 * 1024

# How far a user can move a planned session when pushing to the watch. The
# rationale is "moving the session within a small window, not authoring a new
# week" — wider windows would conflict with the plan structure (week boundaries,
# spacing between hard days, etc.). Symmetric around the planned date.
_PUSH_DATE_WINDOW_DAYS = 7

from stride_storage.sqlite.database import Database
from stride_core.plan_spec import SUPPORTED_SCHEMA_VERSION, SessionKind, WeeklyPlan
from stride_core.source import Capability, DataSource, FeatureNotSupported
from stride_core.timefmt import today_shanghai
from stride_core.workout_spec import NormalizedRunWorkout, NormalizedStrengthWorkout

from plan_parser import parse_plan_md
from ..bearer import reject_deleting_user
from ..content_store import read_json as content_read_json
from ..content_store import read_text as content_read_text
from ..config import load_server_config
from ..config.models import InternalConfig, PlanConfig, ServerConfig
from ..deps import (
    format_duration,
    get_db,
    get_plan_state_store,
    get_source_for_user,
    get_server_config,
    parse_week_dates,
)
from ..sqlite_writer import try_user_sqlite_writer
from ..weekly_plan_store import (
    find_session,
    get_weekly_plan_store,
    nutrition_to_api,
    plans_in_range,
    save_weekly_plan,
    session_to_api,
)

logger = logging.getLogger(__name__)

router = APIRouter()
internal_router = APIRouter()


# ─────────────────────────────────────────────────────────────────────────────
# Internal-token dependency
# ─────────────────────────────────────────────────────────────────────────────


def validate_internal_token_value(actual: str | None, config: InternalConfig) -> None:
    """Validate an internal token header value against typed config.

    Returns 401 when the config value is unset (we won't accept *any* token if the
    server has no expected value), the header is missing, or the values do
    not match. Mirrors the ``Bearer`` dep's failure shape so clients see a
    consistent error envelope.
    """
    expected = config.token
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Internal token not configured on server",
        )
    # Use constant-time comparison to avoid leaking the expected token via
    # response-time differences (str ``==`` short-circuits on first mismatch).
    if not actual or not _secrets.compare_digest(actual, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid internal token",
        )


def _server_config(config: ServerConfig | None) -> ServerConfig:
    return config if config is not None else load_server_config(use_cache=False)


def require_internal_token(
    x_internal_token: str | None = Header(default=None, alias="X-Internal-Token"),
    config: ServerConfig | None = Depends(get_server_config),
) -> None:
    """Validate ``X-Internal-Token`` against server runtime config."""
    validate_internal_token_value(x_internal_token, _server_config(config).internal)


def prefer_authored_json_from_config(config: PlanConfig) -> bool:
    return config.prefer_authored_json


# ─────────────────────────────────────────────────────────────────────────────
# Row → JSON helpers (keep response shape stable + minimal)
# ─────────────────────────────────────────────────────────────────────────────


def _shanghai_today_iso() -> str:
    return today_shanghai().isoformat()


def _scheduled_id(db: Database, folder: str, session) -> int | None:
    row = db.get_latest_scheduled_workout_for_plan_session(
        folder, session.date, session.session_index
    )
    return int(row["id"]) if row is not None else None


def _planned_vs_actual(db: Database, plan: WeeklyPlan | None, day: str) -> list[dict[str, Any]]:
    """Cross-reference planned sessions for ``day`` with synced activities.

    Activities are matched by date prefix only. We expose a tiny shape
    (planned summary + per-activity actuals) so the frontend can colour-code
    adherence without the server enforcing a single rubric.
    """
    sessions = [s for s in plan.sessions if s.date == day] if plan else []
    rows = db.get_activities_for_shanghai_day(day)
    activities = [dict(r) for r in rows]

    out: list[dict[str, Any]] = []
    for s in sessions:
        # Match heuristic: kind=run pairs with running activities (sport='run'
        # if normalized, else sport_type==100); kind=strength with strength
        # activities (sport_type==4). Anything else: leave actual=None.
        actual = None
        if s.kind == SessionKind.RUN:
            for a in activities:
                if a.get("sport") == "run" or a.get("sport_type") == 100:
                    actual = a
                    break
        elif s.kind == SessionKind.STRENGTH:
            for a in activities:
                if a.get("sport") == "strength" or a.get("sport_type") == 4:
                    actual = a
                    break
        out.append({
            "planned": session_to_api(
                plan.week_folder, s,
                scheduled_workout_id=_scheduled_id(db, plan.week_folder, s),
            ),
            "actual": actual,
        })
    return out


def _legacy_plans_in_range(
    user: str, date_from: str, date_to: str, *,
    canonical_folders: set[str] | None = None,
) -> list[WeeklyPlan]:
    """Read historical SQLite plans when no canonical plan covers the week.

    This is a migration-only compatibility path. It never promotes or mutates
    the legacy rows, and canonical ``WeeklyPlanStore`` entries always win.
    """
    canonical_folders = canonical_folders or set()
    canonical_bounds = {
        bounds for folder in canonical_folders
        if (bounds := parse_week_dates(folder)) is not None
    }
    legacy = get_plan_state_store(user)
    try:
        session_rows = legacy.get_planned_sessions(
            date_from=date_from, date_to=date_to
        )
        nutrition_rows = legacy.get_planned_nutrition(
            date_from=date_from, date_to=date_to
        )
        folders = {
            row["week_folder"] for row in (*session_rows, *nutrition_rows)
            if row["week_folder"] not in canonical_folders
            and parse_week_dates(row["week_folder"]) not in canonical_bounds
        }
        plans: list[WeeklyPlan] = []
        for folder in sorted(folders):
            try:
                plan = legacy.get_structured_weekly_plan(folder)
            except (ValueError, TypeError, KeyError, json.JSONDecodeError):
                logger.warning(
                    "ignoring invalid legacy structured plan user=%s folder=%s",
                    user, folder, exc_info=True,
                )
                continue
            if plan is not None:
                plans.append(plan)
        return plans
    finally:
        legacy.close()


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

    plans = plans_in_range(user, date_from, date_to)
    plans.extend(
        _legacy_plans_in_range(
            user, date_from, date_to,
            canonical_folders={plan.week_folder for plan in plans},
        )
    )

    by_date: dict[str, dict[str, Any]] = {}
    cur = d_from
    while cur <= d_to:
        iso = cur.isoformat()
        by_date[iso] = {"date": iso, "sessions": [], "nutrition": None}
        cur += timedelta(days=1)
    db = get_db(user)
    try:
        for plan in plans:
            for session in plan.sessions:
                if session.date in by_date:
                    by_date[session.date]["sessions"].append(
                        session_to_api(
                            plan.week_folder, session,
                            scheduled_workout_id=_scheduled_id(
                                db, plan.week_folder, session
                            ),
                        )
                    )
            for item in plan.nutrition:
                if item.date in by_date:
                    by_date[item.date]["nutrition"] = nutrition_to_api(item)
    finally:
        db.close()

    return {"days": [by_date[k] for k in sorted(by_date.keys())]}


@router.get("/api/{user}/plan/today")
def get_plan_today(user: str):
    today = _shanghai_today_iso()
    db = get_db(user)
    plan = get_weekly_plan_store().get_current_plan(user, today)
    if plan is None:
        legacy = _legacy_plans_in_range(user, today, today)
        plan = legacy[0] if legacy else None
    try:
        session_rows = [s for s in plan.sessions if s.date == today] if plan else []
        nutrition_rows = [n for n in plan.nutrition if n.date == today] if plan else []
        planned_vs_actual = _planned_vs_actual(db, plan, today)
        sessions_payload = [
            session_to_api(
                plan.week_folder, session,
                scheduled_workout_id=_scheduled_id(db, plan.week_folder, session),
            )
            for session in session_rows
        ] if plan else []
    finally:
        db.close()
    return {
        "date": today,
        "sessions": sessions_payload,
        "nutrition": nutrition_to_api(nutrition_rows[0]) if nutrition_rows else None,
        "planned_vs_actual": planned_vs_actual,
    }


def _push_guard_or_raise(plan: WeeklyPlan | None, week_folder: str) -> None:
    """Reject a missing structured plan; canonical plans are pushable."""
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "structured plan not fresh, click 重新解析 first",
                "structured_status": None,
            },
        )


def _legacy_session_for_push(
    user: str, date: str, session_index: int, db: Database,
) -> tuple[WeeklyPlan, Any] | None:
    """Read-only transition fallback for pre-migration SQLite plans."""
    row = db.get_planned_session_by_date_index(date, session_index)
    if row is None:
        return None
    plan = get_weekly_plan_store().get_plan(user, row["week_folder"])
    if plan is not None:
        return find_session(
            user, date, session_index, folder=row["week_folder"]
        )
    parent = db.get_weekly_plan_row(row["week_folder"])
    legacy_status = parent["structured_status"] if parent is not None else None
    if legacy_status not in ("fresh", "authored"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "structured plan not fresh, click 重新解析 first",
                "structured_status": legacy_status,
            },
        )
    try:
        kind = SessionKind(row["kind"])
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Stored session has unsupported kind: {row['kind']!r}",
        ) from exc
    spec = None
    if row["spec_json"] and kind in (SessionKind.RUN, SessionKind.STRENGTH):
        try:
            spec_data = json.loads(row["spec_json"])
            spec = (
                NormalizedRunWorkout.from_dict(spec_data)
                if kind == SessionKind.RUN
                else NormalizedStrengthWorkout.from_dict(spec_data)
            )
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Stored spec is not a valid normalized workout: {exc}",
            ) from exc
    from stride_core.plan_spec import PlannedSession

    session = PlannedSession(
        date=row["date"], session_index=row["session_index"], kind=kind,
        summary=row["summary"], spec=spec, notes_md=row["notes_md"],
        total_distance_m=row["total_distance_m"],
        total_duration_s=row["total_duration_s"],
    )
    return WeeklyPlan(week_folder=row["week_folder"], sessions=(session,)), session


def push_single_session(
    user: str,
    date: str,
    session_index: int,
    source: Any = None,
    db: Any = None,
    plan_store: Any = None,
) -> dict[str, Any]:
    """Helper: push one planned session, returning a dict (never raises).

    Used by ``POST /api/{user}/plan/{folder}/push`` (whole-week push in
    ``routes/generate.py``) so a single failing session doesn't blow up
    the whole batch. Internally delegates to ``push_planned_session``
    (the route handler) and translates ``HTTPException`` to the
    ``{success, error, retryable}`` shape.

    Args after ``session_index`` are unused; they exist so callers that
    pass them by name (legacy signature) don't break.
    """
    from fastapi import HTTPException as _HE

    from ..deps import get_source_for_user

    if source is None:
        source = get_source_for_user(user)

    try:
        # Call the route handler as a plain function. ``target_date=None``
        # keeps the planned date.
        result = push_planned_session(
            user=user,
            date=date,
            session_index=session_index,
            target_date=None,
            source=source,
        )
        return {"success": True, "error": None, "retryable": False, **(result or {})}
    except _HE as exc:
        retryable = exc.status_code in (502, 503, 504)
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        return {"success": False, "error": detail, "retryable": retryable}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": str(exc), "retryable": True}


@router.post("/api/{user}/plan/sessions/{date}/{session_index}/push")
def push_planned_session(
    user: str,
    date: str,
    session_index: int,
    target_date: str | None = Query(
        default=None,
        description=(
            "Optional ISO YYYY-MM-DD date to actually push to. When provided, "
            "must be within ±7 days of the planned date. Omitting keeps the "
            "planned date."
        ),
    ),
    source: DataSource = Depends(get_source_for_user),
):
    """Push a single planned RUN or STRENGTH session to the user's watch.

    ``target_date`` lets the user move the session within ±7 days of the
    planned date (calendar shows planned date; watch lands on chosen date).
    Re-pushing with a different ``target_date`` deletes the prior pushed-date
    watch entry so the session is moved, not duplicated.

    Path:
      - 404 when no canonical or historical planned session exists
      - 409 when a historical SQLite fallback has an unreviewed
        ``structured_status`` (e.g. ``backfilled`` or ``parse_failed``)
      - 400 when ``target_date`` is malformed or outside the ±7-day window
      - 400 when the session is not RUN/STRENGTH, has no spec, or the provider
        lacks the matching ``PUSH_RUN_WORKOUT`` / ``PUSH_STRENGTH_WORKOUT``
        capability
      - 400 when re-pushing requires deletion but the provider lacks
        ``DELETE_WORKOUT``
      - 502 when the upstream watch service rejects the push

    On success: a new ``scheduled_workout`` row is created with
    ``status='pushed'`` (``date=target_date or planned date``); any prior row
    for the canonical session is marked ``status='superseded'`` after its
    watch-side template is removed.
    """
    db = get_db(user)
    try:
        canonical = get_weekly_plan_store().get_current_plan(user, date)
        session = next(
            (
                item for item in canonical.sessions
                if item.date == date and item.session_index == session_index
            ),
            None,
        ) if canonical is not None else None
        found = (canonical, session) if canonical is not None and session is not None else None
        if canonical is None:
            found = _legacy_session_for_push(user, date, session_index, db)
        if found is None:
            raise HTTPException(status_code=404, detail="Planned session not found")
        plan, session = found

        session_kind = session.kind.value
        if session_kind not in (SessionKind.RUN.value, SessionKind.STRENGTH.value):
            raise HTTPException(
                status_code=400,
                detail=f"Push only supports kind=run or kind=strength; got {session_kind!r}",
            )
        if session.spec is None:
            raise HTTPException(
                status_code=400,
                detail="Planned session has no spec (aspirational); cannot push",
            )

        week_folder = plan.week_folder
        _push_guard_or_raise(plan, week_folder)

        if session_kind == SessionKind.RUN.value:
            required_cap = Capability.PUSH_RUN_WORKOUT
            workout_label = "run workouts"
        else:
            required_cap = Capability.PUSH_STRENGTH_WORKOUT
            workout_label = "strength workouts"
        if required_cap not in source.info.capabilities:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Provider {source.info.name!r} does not support pushing {workout_label}"
                ),
            )

        workout: NormalizedRunWorkout | NormalizedStrengthWorkout
        try:
            spec_data = session.spec.to_dict()
            if session_kind == SessionKind.RUN.value:
                workout = NormalizedRunWorkout.from_dict(spec_data)
            else:
                workout = NormalizedStrengthWorkout.from_dict(spec_data)
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Stored spec is not a valid normalized workout: {exc}",
            )

        # Resolve push_date: optional target_date moves the session within
        # ±_PUSH_DATE_WINDOW_DAYS of the planned date. Calendar still anchors
        # on the planned date; only the watch-side date moves.
        push_date = date
        if target_date is not None:
            try:
                planned_d = date_cls.fromisoformat(date)
                target_d = date_cls.fromisoformat(target_date)
            except ValueError:
                raise HTTPException(
                    status_code=400,
                    detail="target_date must be ISO YYYY-MM-DD",
                )
            delta_days = abs((target_d - planned_d).days)
            if delta_days > _PUSH_DATE_WINDOW_DAYS:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"target_date {target_date} is {delta_days} days from planned "
                        f"date {date}; allowed window is ±{_PUSH_DATE_WINDOW_DAYS} days"
                    ),
                )
            push_date = target_d.isoformat()
            # Keep the workout's internal date field consistent with push_date
            # so adapter-side YYYYMMDD translation lands on the right day.
            workout = dataclasses.replace(workout, date=push_date)

        # Resolve prior execution state from the canonical reverse identity.
        # The delete sweep below is not gated on finding a tracked prior: it
        # also clears an untracked stale [STRIDE] entry left on the watch.
        # The adapter's delete_scheduled_workout filters to ``[STRIDE]``-
        # prefixed entries internally, so we never delete user-authored
        # workouts.
        prior = db.get_latest_scheduled_workout_for_plan_session(
            week_folder, date, session_index
        )
        prior_id = prior["id"] if prior is not None else None
        prior_was_pushed = False
        prior_pushed_date: str | None = None
        if prior is not None:
            if prior["status"] == "pushed":
                prior_was_pushed = True
                prior_pushed_date = prior["date"]

        if Capability.DELETE_WORKOUT in source.info.capabilities:
            # Sweep both the new target date (clearing any stale STRIDE entry
            # already there) AND the prior pushed date when the user moved
            # the session — otherwise the old watch entry is left as
            # garbage. dedupe so we never call twice for the same date.
            sweep_dates = {push_date}
            if prior_pushed_date and prior_pushed_date != push_date:
                sweep_dates.add(prior_pushed_date)
            for sweep_date in sweep_dates:
                try:
                    # Filter sweep by exact program name so we only clear
                    # the prior push of THIS session — leaving other
                    # [STRIDE] entries on the same date (run + strength on
                    # a force-day, multiple sessions of the same kind)
                    # untouched. Re-pushing the same session reuses
                    # ``workout.name`` so the old copy is reliably cleared.
                    # Both NormalizedRunWorkout and NormalizedStrengthWorkout
                    # expose ``name``.
                    source.delete_scheduled_workout(user, sweep_date, name=workout.name)
                except FeatureNotSupported:
                    # Capability check passed but adapter changed at runtime
                    # — log + skip rather than fail the push. The new push
                    # can still land; user may end up with a duplicate they
                    # need to clean manually.
                    logger.warning(
                        "delete_scheduled_workout raised FeatureNotSupported "
                        "despite capability advertised; skipping",
                    )
                except Exception:
                    # Best-effort: log and continue. We prefer "push
                    # succeeds with possible duplicate watch entry" over
                    # "push fails because the cleanup leg failed". The user
                    # can manually remove the duplicate; failing here would
                    # block them entirely.
                    logger.exception(
                        "best-effort delete prior STRIDE workouts on %s "
                        "failed; continuing push", sweep_date,
                    )
        else:
            if prior_was_pushed:
                # Provider can't delete and we have a tracked prior →
                # preserve the existing 400 contract: ask the user to
                # manually clean before re-pushing.
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Provider {source.info.name!r} does not support deletion; "
                        "remove the prior workout from the watch manually before re-pushing"
                    ),
                )

        try:
            if session_kind == SessionKind.RUN.value:
                provider_workout_id = source.push_run_workout(user, workout)
            else:
                provider_workout_id = source.push_strength_workout(user, workout)
        except FeatureNotSupported:
            raise HTTPException(
                status_code=400,
                detail=f"Provider {source.info.name!r} does not support pushing {workout_label}",
            )
        except Exception:
            logger.exception(
                "push_%s_workout failed user=%s provider=%s",
                session_kind, user, source.info.name,
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

        # Push succeeded — atomically commit device execution state only:
        # insert the new scheduled_workout row, mark it pushed, and supersede
        # the prior row. The canonical WeeklyPlan remains unchanged.
        #
        # spec_json: when push_date was overridden we re-serialize the workout
        # so the stored spec's internal ``date`` matches the row's ``date``
        # column (and matches what the watch actually received). When the
        # planned date is unchanged we reuse the original payload to avoid
        # touching whitespace / field ordering.
        spec_json_to_store = (
            json.dumps(session.spec.to_dict(), ensure_ascii=False) if push_date == date
            else json.dumps(workout.to_dict(), ensure_ascii=False)
        )
        new_sw_id = db.record_pushed_scheduled_workout(
            week_folder=week_folder,
            planned_date=date,
            session_index=session_index,
            push_date=push_date,
            kind=session_kind,
            name=workout.name,
            spec_json=spec_json_to_store,
            provider=source.info.name,
            provider_workout_id=provider_workout_id,
            prior_id=prior_id if prior_was_pushed else None,
        )

        return {
            "ok": True,
            "planned_session_id": session_to_api(week_folder, session)["id"],
            "scheduled_workout_id": new_sw_id,
            "provider": source.info.name,
            "provider_workout_id": provider_workout_id,
            "push_date": push_date,
        }
    finally:
        db.close()


def _try_authored_reparse(
    user: str, folder: str, content_md: str, generated_by: str | None,
    *, source_hash: str | None = None,
) -> dict[str, Any] | None:
    """Try plan.json-first reparse path. Returns response dict on success, None to fall through.

    Phase 1 plan.json-priority logic. Gated by server config. The legacy
    ``STRIDE_PLAN_JSON_PRIORITY`` env var maps to ``plan.prefer_authored_json``.
    When plan.json exists at the legacy content-store import path
    and parses against ``SUPPORTED_SCHEMA_VERSION``, we promote it directly to the
    structured layer with ``structured_source='authored'`` — bypassing the LLM
    reverse parser entirely. Any failure (missing file, malformed JSON, schema
    skew, validation error) returns ``None`` so the caller falls through to the
    existing LLM path.
    """
    if not prefer_authored_json_from_config(load_server_config(use_cache=False).plan):
        return None
    plan_json_path = f"{user}/logs/{folder}/plan.json"
    try:
        json_result = content_read_json(plan_json_path)
    except Exception as exc:
        logger.warning("plan.json read failed for %s: %s", plan_json_path, exc)
        return None
    if json_result is None:
        return None
    json_data, _source = json_result
    schema_str = json_data.get("schema", "") if isinstance(json_data, dict) else ""
    try:
        schema_version = int(schema_str.split("/v")[-1]) if "/v" in schema_str else None
    except (ValueError, IndexError):
        schema_version = None
    if schema_version is None:
        logger.warning("plan.json missing valid schema field at %s", plan_json_path)
        return None
    if schema_version > SUPPORTED_SCHEMA_VERSION:
        logger.warning(
            "plan.json schema_version=%s > SUPPORTED=%s at %s, falling through",
            schema_version, SUPPORTED_SCHEMA_VERSION, plan_json_path,
        )
        return None
    try:
        weekly_plan = WeeklyPlan.from_dict(json_data)
    except Exception as exc:
        # Catch broadly: ``WeeklyPlan.from_dict`` recurses through
        # ``PlannedSession`` → ``NormalizedRunWorkout`` → ``WorkoutBlock`` →
        # ``Duration``/``Target`` etc. Any of those can raise ``AttributeError``,
        # ``IndexError``, or custom dataclass-validation errors that aren't in
        # the (ValueError, KeyError, TypeError) tuple. We never want a malformed
        # plan.json to surface as a 500 to the webhook caller — log + fall
        # through to the LLM path instead.
        logger.warning(
            "plan.json schema invalid at %s: %s (%s)",
            plan_json_path, exc, type(exc).__name__,
        )
        return None
    try:
        save_weekly_plan(
            user, weekly_plan, expected_folder=folder, generated_by=generated_by,
            source_hash=source_hash,
        )
    except ValueError as exc:
        logger.warning("plan.json identity invalid at %s: %s", plan_json_path, exc)
        return None
    logger.info(
        "plan.json authored path: user=%s folder=%s schema=v%d",
        user, folder, schema_version,
    )
    return {
        "structured_status": "authored",
        "source": "authored",
        "llm_calls": 0,
        "schema_version": schema_version,
        "parse_error": None,
    }


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

    plan_store = get_plan_state_store(user)
    try:
        row = plan_store.get_weekly_plan_row(folder)
        existing_generated_by = row["generated_by"] if row else None
        content_md = row["content_md"] if row else ""
    finally:
        plan_store.close()

    # Fall back to the on-disk plan.md when the DB row is empty. Historical
    # weeks were authored by hand + git-pushed via sync-data.yml, never went
    # through `apply_weekly_plan`, so weekly_plan.content_md is NULL for
    # them. Reading from disk lets the user trigger reparse on those weeks
    # without first having to re-import each one through the coach CLI.
    if not content_md:
        disk_md = content_read_text(f"{user}/logs/{folder}/plan.md")
        if disk_md:
            content_md = disk_md.content
    # Phase 1 plan.json-priority short-circuit. When plan.json is present and
    # parses against the supported schema, promote it as ``authored`` and skip
    # the LLM call entirely. This deliberately precedes the Markdown
    # precondition: a valid structured plan is independently importable.
    authored = _try_authored_reparse(
        user, folder, content_md, existing_generated_by
    )
    if authored is not None:
        return {
            "ok": True,
            "folder": folder,
            **authored,
        }

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

    result = parse_plan_md(folder=folder, md_text=content_md)
    if result.structured is not None:
        save_weekly_plan(
            user, result.structured, expected_folder=folder,
            generated_by=existing_generated_by,
        )
    structured_status = "fresh" if result.structured is not None else "parse_failed"
    return {
        "ok": True,
        "folder": folder,
        "structured_status": structured_status,
        "source": structured_status,
        "llm_calls": 1,
        "schema_version": None,
        "parse_error": result.parse_error,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Internal route — webhook from sync-data.yml
# ─────────────────────────────────────────────────────────────────────────────


def _hold_internal_plan_writer(user: str = Query(...)) -> Iterator[None]:
    """Serialize reparse writes with sync and account deletion for this user."""
    with try_user_sqlite_writer(user) as acquired:
        if not acquired:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="user SQLite writer is busy; retry plan reparse later",
                headers={"Retry-After": "2"},
            )
        reject_deleting_user(user)
        yield


@internal_router.post("/internal/plan/reparse")
def internal_reparse_plan(
    user: str = Query(...),
    folder: str = Query(...),
    _token: None = Depends(require_internal_token),
    _writer: None = Depends(_hold_internal_plan_writer),
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

    plan_store = get_plan_state_store(user)
    try:
        row = plan_store.get_weekly_plan_row(folder)
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
        plan_store.close()

    # Same disk fallback as the public reparse route — sync-data.yml uploads
    # plan.md to Azure Files but doesn't write the DB row, so the first
    # webhook for a new week reads from disk.
    if not content_md:
        disk_md = content_read_text(f"{user}/logs/{folder}/plan.md")
        if disk_md:
            content_md = disk_md.content
    # Phase 1 plan.json-priority short-circuit. plan.json supersedes the hash
    # idempotency check because the schema-validated JSON is its own source of
    # truth — even when plan.md is absent or unchanged, plan.json may have been
    # created or updated.
    md_hash = (
        hashlib.sha256(content_md.encode("utf-8")).hexdigest()
        if content_md else None
    )
    authored = _try_authored_reparse(
        user, folder, content_md, existing_generated_by, source_hash=md_hash
    )
    if authored is not None:
        return {
            "ok": True, "noop": False, "user": user, "folder": folder,
            **authored,
        }
    if not content_md:
        raise HTTPException(
            status_code=404,
            detail=f"No stored plan for week {folder!r}",
        )
    if get_weekly_plan_store().get_source_hash(user, folder) == md_hash:
        return {
            "ok": True, "noop": True, "user": user, "folder": folder,
            "structured_status": "canonical", "source": "canonical",
            "llm_calls": 0, "schema_version": None, "parse_error": None,
        }
    if (
        prior_hash == md_hash
        and prior_status in ("fresh", "authored")
        and get_weekly_plan_store().get_plan(user, folder) is not None
    ):
        # Idempotent re-run: same plan.md + last parse already in a canonical
        # state (LLM-fresh or plan.json-authored). Skip the LLM call and echo
        # the prior status. ``source`` mirrors ``structured_status`` directly
        # because we know it's one of the accepted canonical values here.
        return {
            "ok": True,
            "noop": True,
            "user": user,
            "folder": folder,
            "structured_status": prior_status,
            "source": prior_status,
            "llm_calls": 0,
            "schema_version": None,
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

    result = parse_plan_md(folder=folder, md_text=content_md)
    if result.structured is not None:
        save_weekly_plan(
            user, result.structured, expected_folder=folder,
            generated_by=existing_generated_by, source_hash=md_hash,
        )
    structured_status = "fresh" if result.structured is not None else "parse_failed"
    return {
        "ok": True,
        "noop": False,
        "user": user,
        "folder": folder,
        "structured_status": structured_status,
        "source": structured_status,
        "llm_calls": 1,
        "schema_version": None,
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
