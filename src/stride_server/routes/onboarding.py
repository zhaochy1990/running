"""Onboarding action endpoints: COROS login, complete, sync-status."""

from __future__ import annotations

import logging
import json
import re
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from stride_core.registry import ProviderRegistry, UnknownProvider
from stride_core.source import LoginCredentials

from .. import onboarding_state
from ..bearer import require_bearer
from ..config import load_server_config
from ..config.models import SyncConfig
from ..content_store import read_json
from ..sqlite_writer import hold_writer

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


def _is_account_deleting(uuid: str) -> bool:
    from stride_server.jobs import account_deletion

    return account_deletion.is_deleting(uuid)


def _reject_if_deleting(uuid: str) -> None:
    """Refuse writes when the account deletion fence exists or is unreadable."""
    try:
        deleting = _is_account_deleting(uuid)
    except Exception as exc:  # noqa: BLE001 — coordination-store boundary
        logger.exception("deletion-fence check failed for %s", uuid)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not verify account state; try again shortly.",
        ) from exc
    if deleting:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="This account is being deleted.",
        )


def _read_onboarding(uuid: str) -> dict[str, Any]:
    _validate_uuid(uuid)
    return onboarding_state.read(uuid)


def _write_onboarding(uuid: str, data: dict[str, Any]) -> None:
    _validate_uuid(uuid)
    onboarding_state.write(uuid, data)


def _persist_projected_onboarding(uuid: str, data: dict[str, Any]) -> None:
    """Persist status projection without racing account deletion cleanup."""
    with hold_writer(uuid):
        _reject_if_deleting(uuid)
        _write_onboarding(uuid, data)


def _utcnow_iso() -> str:
    return onboarding_state.now_iso()


def _start_onboarding_pipeline(uuid: str) -> str | None:
    """Ensure the serial health → history → calibration pipeline is running."""
    try:
        from stride_server.jobs.orchestrator import start_pipeline

        onboarding = _read_onboarding(uuid)
        existing = onboarding.get("onboarding_pipeline_run_id")
        if existing:
            store = _pipeline_run_store()
            run = store.get(uuid, existing) if store else None
            if run is not None and run.status.value in ("queued", "running", "done"):
                return str(existing)

        now = _utcnow_iso()
        onboarding.update(
            {
                "sync_state": "running",
                "completed_at": None,
                "sync_progress": {
                    "phase": "queued",
                    "message": "正在同步健康数据，马上就好",
                    "percent": 0,
                    "started_at": now,
                    "updated_at": now,
                },
                "full_sync_state": "running",
                "full_sync_progress": {
                    "phase": "queued",
                    "message": "健康同步后将继续同步历史训练数据",
                    "percent": 0,
                    "started_at": now,
                    "updated_at": now,
                },
            }
        )
        onboarding.pop("error", None)
        onboarding.pop("failed_at", None)
        onboarding.pop("full_sync_error", None)
        onboarding.pop("full_sync_failed_at", None)
        _write_onboarding(uuid, onboarding)

        run_id = start_pipeline("onboarding", partition_key=uuid)
        latest = _read_onboarding(uuid)
        latest["onboarding_pipeline_run_id"] = run_id
        _write_onboarding(uuid, latest)
        logger.info("onboarding pipeline run %s started for %s", run_id, uuid)
        return run_id
    except Exception:
        logger.exception("failed to start onboarding pipeline for %s", uuid)
        return None


def _pipeline_run_store():
    try:
        from stride_server.jobs import get_pipeline_run_store

        return get_pipeline_run_store()
    except Exception:
        return None


def _pipeline_snapshot(uuid: str, onboarding: dict[str, Any]):
    run_id = onboarding.get("onboarding_pipeline_run_id")
    if not run_id:
        return None
    store = _pipeline_run_store()
    run = store.get(uuid, str(run_id)) if store else None
    if run is None:
        return None
    steps = {
        str(step.get("name")): step
        for step in (json.loads(run.steps_json) if run.steps_json else [])
    }
    return run, steps


def _step_job(uuid: str, step: dict[str, Any] | None):
    job_id = step.get("job_id") if step else None
    if not job_id:
        return None
    try:
        from stride_server.jobs import get_job_client

        return get_job_client().get(uuid, str(job_id))
    except Exception:
        return None


def _job_result(job: Any) -> dict[str, Any]:
    if job is None or not job.result_json:
        return {}
    try:
        payload = json.loads(job.result_json)
    except (TypeError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _project_pipeline_status(
    uuid: str,
    onboarding: dict[str, Any],
) -> dict[str, Any]:
    snapshot = _pipeline_snapshot(uuid, onboarding)
    if snapshot is None:
        return onboarding
    run, steps = snapshot
    before = json.dumps(onboarding, sort_keys=True, default=str)
    _project_health_status(uuid, onboarding, run, steps.get("health_sync"))
    _project_full_status(uuid, onboarding, run, steps)
    if json.dumps(onboarding, sort_keys=True, default=str) != before:
        _persist_projected_onboarding(uuid, onboarding)
    return onboarding


def _project_health_status(
    uuid: str,
    onboarding: dict[str, Any],
    run: Any,
    step: dict[str, Any] | None,
) -> None:
    job = _step_job(uuid, step)
    status_value = str(
        getattr(getattr(job, "status", None), "value", None)
        or (step or {}).get("status")
        or "pending"
    )
    if status_value == "done":
        result = _job_result(job)
        completed_at = job.completed_at if job is not None else run.updated_at
        onboarding["sync_state"] = "done"
        onboarding["completed_at"] = completed_at
        onboarding["sync_progress"] = {
            "phase": "complete",
            "message": f"初始化完成：同步 {int(result.get('health') or 0)} 天健康数据",
            "percent": 100,
            "synced_activities": int(result.get("activities") or 0),
            "synced_health": int(result.get("health") or 0),
            "updated_at": completed_at,
        }
        onboarding.pop("error", None)
        onboarding.pop("failed_at", None)
        return
    if status_value == "failed":
        onboarding["sync_state"] = "error"
        onboarding["completed_at"] = None
        onboarding["error"] = run.error_message or "同步失败，请重试"
        onboarding["failed_at"] = run.updated_at
        return
    onboarding["sync_state"] = "running"
    progress = dict(onboarding.get("sync_progress") or {})
    progress.update(
        {
            "phase": getattr(job, "stage", None) or "queued",
            "message": "正在同步健康数据，马上就好",
            "percent": int(getattr(job, "progress_pct", 0) or 0),
            "updated_at": getattr(job, "heartbeat_at", None) or run.updated_at,
        }
    )
    onboarding["sync_progress"] = progress


def _project_full_status(
    uuid: str,
    onboarding: dict[str, Any],
    run: Any,
    steps: dict[str, dict[str, Any]],
) -> None:
    full_job = _step_job(uuid, steps.get("full_sync"))
    if run.status.value == "done":
        result = _job_result(full_job)
        completed_at = run.completed_at or run.updated_at
        onboarding["full_sync_state"] = "done"
        onboarding["full_sync_completed_at"] = completed_at
        onboarding["full_sync_progress"] = {
            "phase": "complete",
            "message": "历史数据与能力模型更新完成",
            "percent": 100,
            "synced_activities": int(result.get("activities") or 0),
            "synced_health": int(result.get("health") or 0),
            "updated_at": completed_at,
        }
        onboarding.pop("full_sync_error", None)
        onboarding.pop("full_sync_failed_at", None)
        return
    if run.status.value == "failed":
        onboarding["full_sync_state"] = "error"
        onboarding["full_sync_error"] = run.error_message or "历史数据同步失败，请重试"
        onboarding["full_sync_failed_at"] = run.updated_at
        return
    current_step = steps.get(str(run.current_step or ""))
    current_job = _step_job(uuid, current_step)
    onboarding["full_sync_state"] = "running"
    progress = dict(onboarding.get("full_sync_progress") or {})
    progress.update(
        {
            "phase": getattr(current_job, "stage", None) or str(run.current_step or "queued"),
            "message": "正在同步历史训练数据并更新能力模型",
            "percent": int(getattr(current_job, "progress_pct", 0) or 0),
            "updated_at": getattr(current_job, "heartbeat_at", None) or run.updated_at,
        }
    )
    onboarding["full_sync_progress"] = progress


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
    _persist_projected_onboarding(uuid, onboarding)
    logger.warning(
        "Marked stale %s sync as error for %s after %.0fs without progress",
        state_key,
        uuid,
        (now - last_update).total_seconds(),
    )
    return onboarding


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
    _reject_if_deleting(uuid)

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

    with hold_writer(uuid):
        _reject_if_deleting(uuid)
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

        _reject_if_deleting(uuid)
        onboarding = _read_onboarding(uuid)
        onboarding["coros_ready"] = True
        _write_onboarding(uuid, onboarding)

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
    _reject_if_deleting(uuid)

    registry: ProviderRegistry = request.app.state.registry
    try:
        source = registry.get("garmin")
    except UnknownProvider:
        logger.error("Garmin adapter not registered; check composition root")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Garmin provider not available in this deployment",
        )

    with hold_writer(uuid):
        _reject_if_deleting(uuid)
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

        _reject_if_deleting(uuid)
        # Reuse the existing onboarding flag — the field name is legacy but the
        # semantic ("watch account is ready, proceed to /onboarding/complete")
        # is provider-agnostic. Renaming to `watch_ready` is a follow-up.
        onboarding = _read_onboarding(uuid)
        onboarding["coros_ready"] = True
        _write_onboarding(uuid, onboarding)

    return {"ok": True, "region": result.region, "user_id": result.user_id}


@router.post("/api/users/me/onboarding/complete")
def onboarding_complete(payload: dict = Depends(require_bearer)):
    """Ensure the serial worker pipeline is running and return health progress."""
    user_id = _validate_uuid(payload["sub"])
    _reject_if_deleting(user_id)
    onboarding = _project_pipeline_status(user_id, _read_onboarding(user_id))

    if onboarding.get("completed_at") and onboarding.get("sync_state") == "done":
        return {"state": "already-complete"}
    if not onboarding.get("coros_ready"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="coros_ready is not set — complete watch login first",
        )

    with hold_writer(user_id):
        _reject_if_deleting(user_id)
        run_id = _start_onboarding_pipeline(user_id)
    onboarding = _read_onboarding(user_id)
    if run_id is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not start onboarding sync; try again shortly.",
        )
    return {
        "state": onboarding.get("sync_state") or "running",
        "progress": onboarding.get("sync_progress"),
    }


@router.get("/api/users/me/sync-status")
def sync_status(payload: dict = Depends(require_bearer)):
    """Return the current background sync state (onboarding health-only sync)."""
    uuid = _validate_uuid(payload["sub"])
    onboarding = _project_pipeline_status(uuid, _read_onboarding(uuid))
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
def full_sync(payload: dict = Depends(require_bearer)):
    """Ensure the serial worker pipeline is running and return history progress."""
    user_id = _validate_uuid(payload["sub"])
    _reject_if_deleting(user_id)
    onboarding = _read_onboarding(user_id)
    if not onboarding.get("coros_ready"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Watch not connected — complete onboarding first",
        )

    if onboarding.get("full_sync_state") != "done":
        with hold_writer(user_id):
            _reject_if_deleting(user_id)
            run_id = _start_onboarding_pipeline(user_id)
        if run_id is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Could not start historical sync; try again shortly.",
            )
        onboarding = _read_onboarding(user_id)
    return {
        "state": onboarding.get("full_sync_state") or "running",
        "progress": onboarding.get("full_sync_progress"),
    }


@router.get("/api/users/me/full-sync-status")
def full_sync_status(payload: dict = Depends(require_bearer)):
    """Return the current full sync state (training plan setup sync)."""
    uuid = _validate_uuid(payload["sub"])
    onboarding = _project_pipeline_status(uuid, _read_onboarding(uuid))
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
