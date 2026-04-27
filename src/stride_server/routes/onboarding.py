"""Onboarding action endpoints: COROS login, complete, sync-status."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel

from stride_core.db import USER_DATA_DIR
from stride_core.source import DataSource

from ..bearer import require_bearer
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


def _onboarding_path(uuid: str) -> Path:
    _validate_uuid(uuid)
    return USER_DATA_DIR / uuid / "onboarding.json"


def _read_onboarding(uuid: str) -> dict[str, Any]:
    p = _onboarding_path(uuid)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {
        "coros_ready": False,
        "profile_ready": False,
        "completed_at": None,
        "sync_state": None,
    }


def _write_onboarding(uuid: str, data: dict[str, Any]) -> None:
    p = _onboarding_path(uuid)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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
    try:
        source.sync_user(uuid, full=False)
    except Exception as exc:
        logger.exception("Background sync failed for %s", uuid)
        onboarding = _read_onboarding(uuid)
        onboarding["sync_state"] = "error"
        onboarding["error"] = str(exc)
        onboarding["completed_at"] = None
        onboarding["failed_at"] = _utcnow_iso()
        _write_onboarding(uuid, onboarding)
        return

    try:
        from stride_core.status_report import generate_starter_status
        # Pass data_root so tests that monkeypatch USER_DATA_DIR cover this
        # write too (and prod uses the same module-level constant).
        generate_starter_status(uuid, data_root=USER_DATA_DIR)
    except Exception:
        logger.exception("Status generation failed for %s", uuid)

    onboarding = _read_onboarding(uuid)
    onboarding["sync_state"] = "done"
    onboarding["completed_at"] = _utcnow_iso()
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
    _write_onboarding(uuid, onboarding)

    background_tasks.add_task(_run_background_sync, uuid, source)

    return {"state": "running"}


@router.get("/api/users/me/sync-status")
def sync_status(payload: dict = Depends(require_bearer)):
    """Return the current background sync state."""
    uuid = _validate_uuid(payload["sub"])
    onboarding = _read_onboarding(uuid)
    result: dict[str, Any] = {"state": onboarding.get("sync_state")}
    if onboarding.get("error"):
        result["error"] = onboarding["error"]
    return result
