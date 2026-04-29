"""Onboarding action endpoints: COROS login, complete, sync-status."""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel

from stride_core.source import DataSource, SyncProgress

from ..bearer import require_bearer
from ..content_store import read_json, write_json
from ..deps import get_source

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


def _sync_stale_after_seconds() -> float:
    value = os.environ.get("STRIDE_SYNC_STALE_AFTER_SECONDS", "300")
    try:
        seconds = float(value)
    except ValueError:
        logger.warning("Invalid STRIDE_SYNC_STALE_AFTER_SECONDS=%r; using 300s", value)
        return 300.0
    return max(seconds, 30.0)


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


def _mark_stale_running_sync(uuid: str, onboarding: dict[str, Any]) -> dict[str, Any]:
    if onboarding.get("sync_state") != "running":
        return onboarding

    progress = dict(onboarding.get("sync_progress") or {})
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
    onboarding["sync_state"] = "error"
    onboarding["error"] = message
    onboarding["completed_at"] = None
    onboarding["failed_at"] = failed_at
    onboarding["sync_progress"] = progress
    _write_onboarding(uuid, onboarding)
    logger.warning(
        "Marked stale onboarding sync as error for %s after %.0fs without progress",
        uuid,
        (now - last_update).total_seconds(),
    )
    return onboarding


def _write_sync_progress(
    uuid: str,
    *,
    state: str | None = None,
    **payload: Any,
) -> dict[str, Any]:
    onboarding = _read_onboarding(uuid)
    if state is not None:
        onboarding["sync_state"] = state

    now = _utcnow_iso()
    progress = dict(onboarding.get("sync_progress") or {})
    progress.update({k: v for k, v in payload.items() if v is not None})
    progress.setdefault("started_at", now)
    progress["updated_at"] = now
    onboarding["sync_progress"] = progress
    _write_onboarding(uuid, onboarding)
    return progress


class CorosLoginBody(BaseModel):
    email: str
    password: str


@router.post("/api/users/me/coros/login")
def coros_login(
    body: CorosLoginBody,
    payload: dict = Depends(require_bearer),
):
    """Authenticate with COROS using the user's credentials.

    On success, persists config.json and marks coros_ready=True.
    Password is never logged.
    """
    uuid = _validate_uuid(payload["sub"])

    from coros_sync.client import CorosClient, CorosAuthError

    try:
        with CorosClient(user=uuid) as client:
            creds = client.login(body.email, body.password)
    except (CorosAuthError, Exception):
        # Collapse auth + network errors to one message to avoid email
        # enumeration. Server-side log retains the real cause.
        logger.exception("COROS login failed for user %s", uuid)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not authenticate with COROS",
        )

    onboarding = _read_onboarding(uuid)
    onboarding["coros_ready"] = True
    _write_onboarding(uuid, onboarding)

    return {"ok": True, "region": creds.region, "user_id": creds.user_id}


def _run_background_sync(uuid: str, source: DataSource) -> None:
    """Background task: sync + generate starter status, update onboarding.json.

    Sets ``completed_at`` ONLY after a successful sync. On failure, writes
    ``sync_state="error"`` with ``completed_at=null`` so the client can
    re-POST ``/onboarding/complete`` to retry.
    """
    def report_progress(progress: SyncProgress) -> None:
        _write_sync_progress(uuid, **progress)

    _write_sync_progress(
        uuid,
        state="running",
        phase="connecting",
        message="正在连接 COROS，准备首次同步",
        percent=3,
    )

    try:
        result = source.sync_user(uuid, full=False, progress=report_progress)
    except Exception as exc:
        logger.exception("Background sync failed for %s", uuid)
        onboarding = _read_onboarding(uuid)
        onboarding["sync_state"] = "error"
        onboarding["error"] = str(exc)
        onboarding["completed_at"] = None
        onboarding["failed_at"] = _utcnow_iso()
        progress = dict(onboarding.get("sync_progress") or {})
        failed_phase = progress.get("phase")
        progress.update(
            {
                "phase": "error",
                "failed_phase": failed_phase,
                "message": "初始化失败，请重试",
                "percent": progress.get("percent", 0),
                "updated_at": onboarding["failed_at"],
            }
        )
        onboarding["sync_progress"] = progress
        _write_onboarding(uuid, onboarding)
        return

    onboarding = _read_onboarding(uuid)
    onboarding["sync_state"] = "done"
    completed_at = _utcnow_iso()
    onboarding["completed_at"] = completed_at
    progress = dict(onboarding.get("sync_progress") or {})
    progress.update(
        {
            "phase": "complete",
            "message": f"初始化完成：同步 {result.activities} 条活动、{result.health} 天健康数据",
            "percent": 100,
            "synced_activities": result.activities,
            "synced_health": result.health,
            "updated_at": completed_at,
        }
    )
    progress.setdefault("started_at", completed_at)
    onboarding["sync_progress"] = progress
    onboarding.pop("error", None)
    onboarding.pop("failed_at", None)
    _write_onboarding(uuid, onboarding)


@router.post("/api/users/me/onboarding/complete")
def onboarding_complete(
    background_tasks: BackgroundTasks,
    payload: dict = Depends(require_bearer),
    source: DataSource = Depends(get_source),
):
    """Kick off background sync + status generation.

    Returns ``{state: "running"}`` while the background task runs, or
    ``{state: "already-complete"}`` only when a previous run finished
    successfully (``sync_state == "done"`` with ``completed_at`` set). An
    errored prior run does NOT count as complete — the client may re-POST.
    """
    uuid = _validate_uuid(payload["sub"])
    onboarding = _read_onboarding(uuid)

    if onboarding.get("completed_at") and onboarding.get("sync_state") == "done":
        return {"state": "already-complete"}

    if not onboarding.get("coros_ready"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="coros_ready is not set — complete COROS login first",
        )
    if not onboarding.get("profile_ready"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="profile_ready is not set — complete profile step first",
        )

    onboarding["sync_state"] = "running"
    onboarding["completed_at"] = None
    onboarding.pop("error", None)
    onboarding.pop("failed_at", None)
    now = _utcnow_iso()
    onboarding["sync_progress"] = {
        "phase": "queued",
        "message": "已提交初始化任务，等待后台同步启动",
        "percent": 0,
        "started_at": now,
        "updated_at": now,
    }
    _write_onboarding(uuid, onboarding)

    background_tasks.add_task(_run_background_sync, uuid, source)

    return {"state": "running", "progress": onboarding["sync_progress"]}


@router.get("/api/users/me/sync-status")
def sync_status(payload: dict = Depends(require_bearer)):
    """Return the current background sync state."""
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
