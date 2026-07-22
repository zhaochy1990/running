"""Full-user sync endpoints — delegates to the configured DataSource.

Two routes:
- POST /api/{user}/sync  — Bearer JWT, called from frontend
- POST /internal/sync    — X-Internal-Token, called from scheduled workflows
                           (see .github/workflows/daily-sync.yml)
Both share `_run_sync` so behavior stays in lockstep.
"""

from __future__ import annotations

import logging
import re
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from stride_core.post_sync import run_post_sync_for_result
from stride_core.registry import ProviderRegistry, UnknownProvider
from stride_core.source import DataSource

from ..bearer import reject_deleting_user, require_bearer
from ..deps import get_source_for_user
from ..sqlite_writer import (
    invalidate_training_load_backfill_progress,
    try_user_sqlite_writer,
)
from .plan import require_internal_token

logger = logging.getLogger(__name__)

router = APIRouter()

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_WRITER_BUSY_MESSAGE = "user SQLite writer is busy; retry sync later"


class _SQLiteWriterBusy(RuntimeError):
    """The per-user API writer is already running another long operation."""


def _run_sync(user: str, full: bool, source: DataSource) -> dict:
    """Shared sync handler used by both Bearer and internal-token routes.

    Sync and training-load shards share the same in-process per-user writer
    guard. This prevents two long API requests from writing the same SQLite file
    concurrently; SQLite handles short incidental contention from other routes.
    """
    with try_user_sqlite_writer(user) as acquired:
        if not acquired:
            raise _SQLiteWriterBusy(_WRITER_BUSY_MESSAGE)
        # Re-check inside the same per-user lock account deletion acquires.
        # A request may have passed its route-level fence check just before
        # DELETE set the durable fence; without this check it could acquire the
        # released lock after cleanup and recreate coros.db.
        reject_deleting_user(user)
        try:
            if not source.is_logged_in(user):
                return {
                    "success": False,
                    "error": f"用户 {user} 未登录，请先运行: coros-sync --profile {user} login",
                }
            invalidate_training_load_backfill_progress(user)
            result = source.sync_user(user, full=full)
            try:
                run_post_sync_for_result(
                    user=user,
                    provider=source.info.name,
                    operation="sync",
                    result=result,
                )
            except Exception:
                logger.exception("post-sync events failed for user %s", user)
            return {
                "success": True,
                "output": f"同步完成: {result.activities} 条活动, {result.health} 条健康记录",
            }
        except sqlite3.OperationalError as exc:
            if "locked" in str(exc).lower():
                raise _SQLiteWriterBusy(_WRITER_BUSY_MESSAGE) from exc
            logger.exception("sync failed for user %s", user)
            return {"success": False, "error": "sync failed"}
        except Exception:
            logger.exception("sync failed for user %s", user)
            return {"success": False, "error": "sync failed"}


@router.post("/api/{user}/sync")
def trigger_sync(
    user: str,
    full: bool = False,
    source: DataSource = Depends(get_source_for_user),
    _claims: dict = Depends(require_bearer),
):
    """Trigger a data sync for the given user (via the configured adapter).

    Pass `?full=true` to bypass the incremental cutoff and re-pull a deeper
    activity history. Useful when the cached snapshot needs older activities
    to populate (e.g. the L3 endurance dimension needs a 25km+ run within
    the 90d window — without `full=1` after a fresh onboard, the user's
    longest historical run may have been truncated by `activity_limit`).

    Protected by Bearer auth when STRIDE_AUTH_PUBLIC_KEY_PEM/PATH is set.
    """
    try:
        return _run_sync(user, full, source)
    except _SQLiteWriterBusy:
        return {
            "success": False,
            "error": _WRITER_BUSY_MESSAGE,
            "retryable": True,
        }


# ─────────────────────────────────────────────────────────────────────────────
# Internal route — used by scheduled workflows (see .github/workflows/daily-sync.yml)
# Auth via X-Internal-Token, NOT bearer. Path is /internal/... so future
# bearer-prefix middleware on /api/* won't accidentally catch it.
# ─────────────────────────────────────────────────────────────────────────────

internal_router = APIRouter()


@internal_router.post("/internal/sync")
def internal_trigger_sync(
    request: Request,
    user: str = Query(..., description="User UUID"),
    full: bool = Query(False),
    _token: None = Depends(require_internal_token),
) -> dict:
    """Trigger a sync for `user` — same logic as POST /api/{user}/sync but
    authenticated via X-Internal-Token instead of Bearer JWT.
    """
    if not _UUID4_RE.match(user):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="user must be a UUID4",
        )
    reject_deleting_user(user)
    registry: ProviderRegistry = request.app.state.registry
    try:
        source: DataSource = registry.for_user(user)
    except UnknownProvider as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Configured watch provider {exc.name!r} is not available in this deployment",
        ) from exc
    try:
        return _run_sync(user, full, source)
    except _SQLiteWriterBusy as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_WRITER_BUSY_MESSAGE,
            headers={"Retry-After": "2"},
        ) from exc
