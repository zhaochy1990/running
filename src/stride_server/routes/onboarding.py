"""Onboarding action endpoints: COROS login, complete, sync-status."""

from __future__ import annotations

import logging
import json
import re
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel

from stride_core.registry import ProviderRegistry, UnknownProvider
from stride_core.post_sync import run_post_sync_for_result
from stride_core.source import DataSource, LoginCredentials, SyncProgress

from ..bearer import require_bearer
from ..config import load_server_config
from ..config.models import SyncConfig
from ..content_store import read_json, write_json
from ..deps import get_source
from ..sqlite_writer import (
    invalidate_training_load_backfill_progress,
    try_user_sqlite_writer,
)

logger = logging.getLogger(__name__)

router = APIRouter()

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def _validate_uuid(uuid: str) -> str:
    if not _UUID4_RE.match(uuid or ""):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid user identifier",
        )
    return uuid


def _onboarding_path(uuid: str) -> str:
    _validate_uuid(uuid)
    return f"{uuid}/onboarding.json"


def _read_onboarding(uuid: str) -> dict[str, Any]:
    item = read_json(_onboarding_path(uuid))
    if item is not None:
        data, source = item
        if isinstance(data, dict):
            logger.info("onboarding read user=%s source=%s", uuid, source)
            return data
        logger.warning("onboarding read ignored non-object JSON for user=%s source=%s", uuid, source)
    return {
        "coros_ready": False,
        "profile_ready": False,
        "completed_at": None,
        "sync_state": None,
        "sync_progress": None,
    }


def _write_onboarding(uuid: str, data: dict[str, Any]) -> None:
    source = write_json(_onboarding_path(uuid), data)
    logger.info("onboarding write user=%s source=%s", uuid, source)


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _start_onboarding_pipeline(uuid: str) -> None:
    """Kick off the onboarding pipeline (full sync → calibration → backfill) and
    record its run_id in onboarding.json so the frontend can poll progress.

    Best-effort at the trigger boundary: a failure to enqueue must not fail the
    watch-login response (the user is bound); it is logged and can be retried.
    Skips if a run is already in flight for this user (idempotent re-login).
    """
    try:
        from stride_server.jobs.orchestrator import start_pipeline

        onboarding = _read_onboarding(uuid)
        existing = onboarding.get("onboarding_pipeline_run_id")
        if existing:
            store = _pipeline_run_store()
            run = store.get(uuid, existing) if store else None
            if run is not None and run.status.value in ("queued", "running"):
                return  # already in flight
        run_id = start_pipeline("onboarding", partition_key=uuid)
        onboarding = _read_onboarding(uuid)
        onboarding["onboarding_pipeline_run_id"] = run_id
        _write_onboarding(uuid, onboarding)
        logger.info("onboarding pipeline run %s started for %s", run_id, uuid)
    except Exception:
        logger.exception("failed to start onboarding pipeline for %s", uuid)


def _pipeline_run_store():
    try:
        from stride_server.jobs import get_pipeline_run_store

        return get_pipeline_run_store()
    except Exception:
        return None


def sync_stale_after_seconds_from_config(config: SyncConfig) -> int:
    return config.stale_after_seconds


def _sync_stale_after_seconds() -> float:
    return float(sync_stale_after_seconds_from_config(load_server_config(use_cache=False).sync))


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _mark_stale_running_sync(
    uuid: str,
    onboarding: dict[str, Any],
    *,
    state_key: str = "sync_state",
    progress_key: str = "sync_progress",
) -> dict[str, Any]:
    if onboarding.get(state_key) != "running":
        return onboarding

    progress = dict(onboarding.get(progress_key) or {})
    last_update = _parse_iso_datetime(
        progress.get("updated_at") or progress.get("started_at")
    )
    if last_update is None:
        return onboarding

    now = datetime.now(timezone.utc)
    if (now - last_update).total_seconds() <= _sync_stale_after_seconds():
        return onboarding

    failed_at = now.isoformat()
    failed_phase = progress.get("phase")
    message = "同步任务已停止，请点击重试"
    progress.update(
        {
            "phase": "error",
            "failed_phase": failed_phase,
            "message": message,
            "updated_at": failed_at,
        }
    )
    onboarding[state_key] = "error"
    onboarding["error"] = message
    if state_key == "sync_state":
        onboarding["completed_at"] = None
    onboarding["failed_at"] = failed_at
    onboarding[progress_key] = progress
    _write_onboarding(uuid, onboarding)
    logger.warning(
        "Marked stale %s sync as error for %s after %.0fs without progress",
        state_key,
        uuid,
        (now - last_update).total_seconds(),
    )
    return onboarding


def _write_sync_progress(
    uuid: str,
    *,
    state: str | None = None,
    state_key: str = "sync_state",
    progress_key: str = "sync_progress",
    **payload: Any,
) -> dict[str, Any]:
    onboarding = _read_onboarding(uuid)
    if state is not None:
        onboarding[state_key] = state

    now = _utcnow_iso()
    # Filter out our internal routing keys from the progress payload
    filtered = {
        k: v for k, v in payload.items()
        if v is not None and k not in ("state_key", "progress_key")
    }
    progress = dict(onboarding.get(progress_key) or {})
    progress.update(filtered)
    progress.setdefault("started_at", now)
    progress["updated_at"] = now
    onboarding[progress_key] = progress
    _write_onboarding(uuid, onboarding)
    return progress


class CorosLoginBody(BaseModel):
    email: str
    password: str


@router.post("/api/users/me/coros/login")
def coros_login(
    body: CorosLoginBody,
    request: Request,
    payload: dict = Depends(require_bearer),
):
    """Authenticate with COROS via the registered adapter and persist config.

    Dispatches through `ProviderRegistry.get('coros').login(...)` so this
    route has zero direct dependency on `coros_sync` internals — adding a
    parallel `/garmin/login` later is a one-line change targeting a
    different registry key.

    Password is never logged. Auth + network errors are collapsed to a
    single 400 message to avoid email-enumeration; the underlying cause is
    captured in the server log.
    """
    uuid = _validate_uuid(payload["sub"])

    registry: ProviderRegistry = request.app.state.registry
    try:
        source = registry.get("coros")
    except UnknownProvider:
        # Misconfigured deployment, not user error — bubble as 500.
        logger.error("COROS adapter not registered; check composition root")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="COROS provider not available in this deployment",
        )

    try:
        result = source.login(
            uuid,
            LoginCredentials(email=body.email, password=body.password),
        )
    except Exception:
        logger.exception("COROS login failed for user %s", uuid)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not authenticate with COROS",
        )

    if not result.success:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=result.message or "Could not authenticate with COROS",
        )

    onboarding = _read_onboarding(uuid)
    onboarding["coros_ready"] = True
    _write_onboarding(uuid, onboarding)

    _start_onboarding_pipeline(uuid)

    return {"ok": True, "region": result.region, "user_id": result.user_id}


class GarminLoginBody(BaseModel):
    email: str
    password: str
    region: str | None = "cn"        # 'cn' | 'global'; default CN since
                                     # the deploy targets China-region users.


@router.post("/api/users/me/garmin/login")
def garmin_login(
    body: GarminLoginBody,
    request: Request,
    payload: dict = Depends(require_bearer),
):
    """Authenticate with Garmin Connect via the registered adapter.

    Mirror of /coros/login, dispatched through ProviderRegistry.get('garmin').
    Same enumeration-resistant behavior: any auth/network error → single
    400 with a generic message, real cause goes to the server log.

    On success, the registry's GarminDataSource.login persists OAuth tokens
    to data/{user}/garmin_auth.json and stamps `provider='garmin'` in
    config.json so subsequent registry.for_user(uuid) routes back here.
    """
    uuid = _validate_uuid(payload["sub"])

    registry: ProviderRegistry = request.app.state.registry
    try:
        source = registry.get("garmin")
    except UnknownProvider:
        logger.error("Garmin adapter not registered; check composition root")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Garmin provider not available in this deployment",
        )

    try:
        result = source.login(
            uuid,
            LoginCredentials(
                email=body.email,
                password=body.password,
                region=body.region or "cn",
            ),
        )
    except Exception:
        logger.exception("Garmin login failed for user %s", uuid)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not authenticate with Garmin",
        )

    if not result.success:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=result.message or "Could not authenticate with Garmin",
        )

    # Reuse the existing onboarding flag — the field name is legacy but the
    # semantic ("watch account is ready, proceed to /onboarding/complete")
    # is provider-agnostic. Renaming to `watch_ready` is a follow-up.
    onboarding = _read_onboarding(uuid)
    onboarding["coros_ready"] = True
    _write_onboarding(uuid, onboarding)

    _start_onboarding_pipeline(uuid)

    return {"ok": True, "region": result.region, "user_id": result.user_id}


def _run_background_sync(
    uuid: str,
    source: DataSource,
    *,
    mode: str = "health_only",
    full: bool = False,
) -> None:
    """Background task: sync + update onboarding.json.

    ``mode`` controls scope:
      - ``"health_only"``: lightweight sync for onboarding (dashboard + health
        metrics only, ~10 seconds).
      - ``"full"``: activities + health (used when the user sets up a training
        plan and needs historical data).

    Sets ``completed_at`` ONLY after a successful sync. On failure, writes
    ``sync_state="error"`` with ``completed_at=null`` so the client can retry.
    """
    is_health_only = mode == "health_only"
    state_key = "sync_state" if is_health_only else "full_sync_state"
    progress_key = "sync_progress" if is_health_only else "full_sync_progress"
    error_key = "error" if is_health_only else "full_sync_error"
    failed_at_key = "failed_at" if is_health_only else "full_sync_failed_at"

    def report_progress(progress: SyncProgress) -> None:
        _write_sync_progress(uuid, state_key=state_key, progress_key=progress_key, **progress)

    connecting_msg = (
        "正在连接手表，准备同步健康数据"
        if is_health_only
        else "正在连接手表，准备同步历史训练数据（可能需要几分钟）"
    )
    _write_sync_progress(
        uuid,
        state="running",
        phase="connecting",
        message=connecting_msg,
        percent=3,
        state_key=state_key,
        progress_key=progress_key,
    )

    try:
        with try_user_sqlite_writer(uuid) as acquired:
            if not acquired:
                raise RuntimeError("用户数据正在更新，请稍后重试")
            invalidate_training_load_backfill_progress(uuid)
            result = source.sync_user(
                uuid, full=full, mode=mode, progress=report_progress,
            )
            try:
                run_post_sync_for_result(
                    user=uuid,
                    provider=source.info.name,
                    operation="sync",
                    result=result,
                    progress=report_progress,
                )
            except Exception:
                logger.exception("post-sync events failed for onboarding sync user=%s", uuid)
    except Exception as exc:
        logger.exception("Background sync (mode=%s) failed for %s", mode, uuid)
        onboarding = _read_onboarding(uuid)
        onboarding[state_key] = "error"
        onboarding[error_key] = str(exc)
        if is_health_only:
            onboarding["completed_at"] = None
        onboarding[failed_at_key] = _utcnow_iso()
        progress = dict(onboarding.get(progress_key) or {})
        failed_phase = progress.get("phase")
        progress.update(
            {
                "phase": "error",
                "failed_phase": failed_phase,
                "message": "同步失败，请重试",
                "percent": progress.get("percent", 0),
                "updated_at": onboarding[failed_at_key],
            }
        )
        onboarding[progress_key] = progress
        _write_onboarding(uuid, onboarding)
        return

    onboarding = _read_onboarding(uuid)
    onboarding[state_key] = "done"
    completed_at = _utcnow_iso()
    if is_health_only:
        onboarding["completed_at"] = completed_at
    else:
        onboarding["full_sync_completed_at"] = completed_at
    progress = dict(onboarding.get(progress_key) or {})
    if is_health_only:
        done_msg = f"初始化完成：同步 {result.health} 天健康数据"
    else:
        done_msg = f"数据同步完成：{result.activities} 条训练、{result.health} 天健康数据"
    progress.update(
        {
            "phase": "complete",
            "message": done_msg,
            "percent": 100,
            "synced_activities": result.activities,
            "synced_health": result.health,
            "updated_at": completed_at,
        }
    )
    progress.setdefault("started_at", completed_at)
    onboarding[progress_key] = progress
    onboarding.pop(error_key, None)
    onboarding.pop(failed_at_key, None)
    _write_onboarding(uuid, onboarding)


@router.post("/api/users/me/onboarding/complete")
def onboarding_complete(
    background_tasks: BackgroundTasks,
    request: Request,
    payload: dict = Depends(require_bearer),
):
    """Kick off lightweight health-only background sync for onboarding.

    The new onboarding flow only syncs recent health/dashboard data (~14 days)
    so the user can enter the main page quickly. Full historical sync
    (activities + 3 years of data) is deferred to when the user sets up a
    training plan via ``POST /api/users/me/full-sync``.

    Returns ``{state: "running"}`` while the background task runs, or
    ``{state: "already-complete"}`` only when a previous run finished
    successfully (``sync_state == "done"`` with ``completed_at`` set). An
    errored prior run does NOT count as complete — the client may re-POST.
    """
    uuid = _validate_uuid(payload["sub"])
    onboarding = _read_onboarding(uuid)
    registry: ProviderRegistry = request.app.state.registry
    try:
        source: DataSource = registry.for_user(uuid)
    except UnknownProvider:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="User's configured watch provider is not available",
        )

    if onboarding.get("completed_at") and onboarding.get("sync_state") == "done":
        return {"state": "already-complete"}

    if not onboarding.get("coros_ready"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="coros_ready is not set — complete watch login first",
        )

    onboarding["sync_state"] = "running"
    onboarding["completed_at"] = None
    onboarding.pop("error", None)
    onboarding.pop("failed_at", None)
    now = _utcnow_iso()
    onboarding["sync_progress"] = {
        "phase": "queued",
        "message": "正在同步健康数据，马上就好",
        "percent": 0,
        "started_at": now,
        "updated_at": now,
    }
    _write_onboarding(uuid, onboarding)

    background_tasks.add_task(
        _run_background_sync, uuid, source, mode="health_only",
    )

    return {"state": "running", "progress": onboarding["sync_progress"]}


@router.get("/api/users/me/sync-status")
def sync_status(payload: dict = Depends(require_bearer)):
    """Return the current background sync state (onboarding health-only sync)."""
    uuid = _validate_uuid(payload["sub"])
    onboarding = _read_onboarding(uuid)
    onboarding = _mark_stale_running_sync(uuid, onboarding)
    result: dict[str, Any] = {
        "state": onboarding.get("sync_state"),
        "progress": onboarding.get("sync_progress"),
    }
    if onboarding.get("error"):
        result["error"] = onboarding["error"]
    return result


@router.get("/api/users/me/onboarding/pipeline-status")
def onboarding_pipeline_status(payload: dict = Depends(require_bearer)):
    """Aggregate status of this user's onboarding pipeline run.

    The frontend polls this after watch-login to show "数据同步中" progress. The
    run_id is stored in onboarding.json by the watch-login trigger; returns
    ``{state: "none"}`` when no pipeline has been started.
    """
    uuid = _validate_uuid(payload["sub"])
    onboarding = _read_onboarding(uuid)
    run_id = onboarding.get("onboarding_pipeline_run_id")
    if not run_id:
        return {"state": "none"}
    store = _pipeline_run_store()
    run = store.get(uuid, run_id) if store else None
    if run is None:
        return {"state": "none", "run_id": run_id}
    steps = json.loads(run.steps_json) if run.steps_json else []
    return {
        "state": run.status.value,
        "run_id": run.run_id,
        "current_step": run.current_step,
        "steps": steps,
        "error": run.error_message,
    }


@router.post("/api/users/me/full-sync")
def full_sync(
    background_tasks: BackgroundTasks,
    request: Request,
    payload: dict = Depends(require_bearer),
):
    """Kick off a full historical sync (activities + health).

    Called from the training plan setup page after the user has set their
    race goals. This syncs 3+ years of activities and health data so the
    system can generate a training plan based on historical performance.

    Returns ``{state: "running"}`` immediately; the client polls
    ``GET /api/users/me/full-sync-status`` for progress.
    """
    uuid = _validate_uuid(payload["sub"])
    onboarding = _read_onboarding(uuid)
    registry: ProviderRegistry = request.app.state.registry
    try:
        source: DataSource = registry.for_user(uuid)
    except UnknownProvider:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="User's configured watch provider is not available",
        )

    if not onboarding.get("coros_ready"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Watch not connected — complete onboarding first",
        )

    # Allow re-trigger even if a previous full sync completed (user may
    # want to refresh after connecting a new watch or changing goals).
    if onboarding.get("full_sync_state") == "running":
        return {
            "state": "running",
            "progress": onboarding.get("full_sync_progress"),
        }

    onboarding["full_sync_state"] = "running"
    onboarding.pop("full_sync_error", None)
    onboarding.pop("full_sync_failed_at", None)
    now = _utcnow_iso()
    onboarding["full_sync_progress"] = {
        "phase": "queued",
        "message": "正在准备同步历史训练数据，这可能需要几分钟",
        "percent": 0,
        "started_at": now,
        "updated_at": now,
    }
    _write_onboarding(uuid, onboarding)

    background_tasks.add_task(
        _run_background_sync, uuid, source, mode="full", full=True,
    )

    return {"state": "running", "progress": onboarding["full_sync_progress"]}


@router.get("/api/users/me/full-sync-status")
def full_sync_status(payload: dict = Depends(require_bearer)):
    """Return the current full sync state (training plan setup sync)."""
    uuid = _validate_uuid(payload["sub"])
    onboarding = _read_onboarding(uuid)
    # Reuse stale detection but for the full_sync keys
    onboarding = _mark_stale_running_sync(
        uuid, onboarding,
        state_key="full_sync_state",
        progress_key="full_sync_progress",
    )
    result: dict[str, Any] = {
        "state": onboarding.get("full_sync_state"),
        "progress": onboarding.get("full_sync_progress"),
    }
    if onboarding.get("full_sync_error"):
        result["error"] = onboarding["full_sync_error"]
    return result


# ── B4 onboarding defaults (T17) ───────────────────────────────────────────


class OnboardingDefaults(BaseModel):
    suggested_rhr: int | None = None
    rhr_source: Literal["health"] | None = None
    suggested_max_hr: int | None = None
    max_hr_source: Literal["formula", "health"] | None = None


def _parse_birth_year(profile: dict[str, Any]) -> int | None:
    """Extract birth year from profile.json.

    Looks at ``birth_year`` then ``dob`` (ISO date string).
    """
    if isinstance(profile.get("birth_year"), int):
        return int(profile["birth_year"])
    dob = profile.get("dob")
    if isinstance(dob, str) and len(dob) >= 4:
        try:
            return int(dob[:4])
        except ValueError:
            return None
    return None


def _suggest_rhr_from_health(db) -> int | None:
    """P25 of non-null ``rhr`` over the last 30 daily_health rows.

    Returns None when fewer than 5 samples are available — we don't want
    to seed a misleading value off 1-2 days of data.
    """
    rows = db.query(
        "SELECT rhr FROM daily_health "
        "WHERE rhr IS NOT NULL "
        "ORDER BY date DESC LIMIT 30"
    )
    values: list[int] = []
    for row in rows or []:
        r = dict(row)
        v = r.get("rhr")
        if v is None:
            continue
        try:
            values.append(int(v))
        except (TypeError, ValueError):
            continue
    if len(values) < 5:
        return None
    values.sort()
    # P25 — lower-quartile index using inclusive rule.
    idx = max(0, (len(values) - 1) * 25 // 100)
    return int(values[idx])


@router.get(
    "/api/users/me/onboarding/defaults",
    response_model=OnboardingDefaults,
)
def onboarding_defaults(
    payload: dict = Depends(require_bearer),
) -> OnboardingDefaults:
    """Suggested values for the B4 basic-info form.

    - ``suggested_rhr``: P25 of recent daily_health RHR (≥5 samples).
    - ``suggested_max_hr``: ``220 - age`` when birth_year is known.

    Both fields may be null when their source isn't available; the
    client renders fully blank inputs in that case.
    """
    from ..deps import get_db  # local import to avoid cycle at module load

    uuid = _validate_uuid(payload["sub"])

    # Profile-side: max_hr formula
    profile_item = read_json(f"{uuid}/profile.json")
    profile: dict[str, Any] = {}
    if profile_item is not None:
        data, _ = profile_item
        if isinstance(data, dict):
            profile = data
    birth_year = _parse_birth_year(profile)

    suggested_max_hr: int | None = None
    max_hr_source: Literal["formula", "health"] | None = None
    if birth_year is not None:
        age = datetime.now(timezone.utc).year - birth_year
        if 5 < age < 110:
            suggested_max_hr = 220 - age
            max_hr_source = "formula"

    # Health-side: rhr P25
    suggested_rhr: int | None = None
    rhr_source: Literal["health"] | None = None
    try:
        db = get_db(uuid)
        try:
            suggested_rhr = _suggest_rhr_from_health(db)
            if suggested_rhr is not None:
                rhr_source = "health"
        finally:
            db.close()
    except Exception as exc:  # noqa: BLE001
        # New user with no DB yet is normal — log at debug, return null.
        logger.debug("onboarding_defaults: no health db for user=%s (%s)", uuid, exc)

    return OnboardingDefaults(
        suggested_rhr=suggested_rhr,
        rhr_source=rhr_source,
        suggested_max_hr=suggested_max_hr,
        max_hr_source=max_hr_source,
    )
