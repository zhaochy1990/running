"""Self-service account deletion endpoints."""

from __future__ import annotations

import gc
import logging
import re
import shutil
import sqlite3
import time
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status

from stride_core.db import USER_DATA_DIR
from stride_core.registry import ProviderRegistry, UnknownProvider

from .. import auth_service_client as auth_client
from ..bearer import current_user_id, require_bearer
from ..deps import get_registry
from ..weekly_plan_store import get_weekly_plan_store

logger = logging.getLogger(__name__)

router = APIRouter()

# rmtree on the prod Azure Files SMB mount can transiently fail right after a
# sync: the just-closed coros.db (or its -wal/-shm sidecars) may still hold an
# SMB delayed-close handle, surfacing as OSError "device or resource busy".
# Retry with exponential backoff so a single delete request rides it out.
_RMTREE_ATTEMPTS = 5
_RMTREE_BACKOFF_S = 0.5

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def _bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    if authorization.lower().startswith("bearer "):
        return authorization[len("Bearer ") :].strip()
    return None


def _user_data_path(user_id: str) -> Path:
    if not _UUID4_RE.match(user_id or ""):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid user identifier",
        )

    base = USER_DATA_DIR.resolve()
    path = (USER_DATA_DIR / user_id).resolve()
    if path.parent != base:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid user data path",
        )
    return path


def _release_user_db(db_path: Path) -> None:
    """Collapse WAL sidecars and release any lingering handle before rmtree.

    Best-effort: on the prod Azure Files SMB mount an open coros.db (or its
    -wal/-shm sidecars) blocks directory removal. Opening the DB and running a
    TRUNCATE checkpoint merges the WAL back into the main file and drops the
    sidecars; closing it releases the handle. A `gc.collect()` reaps any
    Database objects a prior request opened and never explicitly closed. Any
    failure here is non-fatal — the rmtree retry loop is the real guarantee.
    """
    if db_path.exists():
        try:
            conn = sqlite3.connect(str(db_path))
            try:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            finally:
                conn.close()
        except sqlite3.Error:
            logger.warning("wal checkpoint before delete failed for %s", db_path, exc_info=True)
    gc.collect()


def _rmtree_resilient(path: Path) -> None:
    """rmtree with bounded exponential backoff for SMB delayed-close races."""
    for attempt in range(_RMTREE_ATTEMPTS):
        try:
            shutil.rmtree(path)
            return
        except OSError:
            if attempt == _RMTREE_ATTEMPTS - 1:
                raise
            time.sleep(_RMTREE_BACKOFF_S * (2 ** attempt))


def _delete_local_user_data(user_id: str) -> None:
    path = _user_data_path(user_id)
    if not path.exists():
        return
    if not path.is_dir():
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="User data path is not a directory",
        )
    _release_user_db(path / "coros.db")
    _rmtree_resilient(path)


def _delete_watch_credentials(user_id: str, registry: ProviderRegistry) -> None:
    """Best-effort watch credential cleanup for account deletion.

    Account deletion removes the whole local user directory, so the only
    durable credential residue risk is the provider backend (prod AKV). The
    adapter owns that backend-specific cleanup via ``logout``.
    """
    try:
        source = registry.for_user(user_id)
    except UnknownProvider:
        logger.warning("cannot delete watch credentials: unknown provider for user %s", user_id)
        return
    try:
        source.logout(user_id)
    except Exception:
        logger.exception("failed to delete watch credentials for user %s", user_id)
        raise


@router.delete("/api/users/me", status_code=status.HTTP_204_NO_CONTENT)
async def delete_my_account(
    authorization: str | None = Header(default=None),
    claims: dict = Depends(require_bearer),
    registry: ProviderRegistry = Depends(get_registry),
):
    user_id = current_user_id(claims)
    _user_data_path(user_id)

    try:
        await auth_client.delete_my_account(_bearer(authorization))
    except auth_client.AuthServiceError as exc:
        if exc.status_code not in (status.HTTP_401_UNAUTHORIZED, status.HTTP_404_NOT_FOUND):
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
        logger.info(
            "auth-service account already unavailable while deleting local data for user %s",
            user_id,
        )
    except auth_client.AuthServiceUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"auth-service unavailable: {exc}") from exc

    try:
        _delete_watch_credentials(user_id, registry)
        get_weekly_plan_store().delete_user(user_id)
        _delete_local_user_data(user_id)
    except OSError as exc:
        logger.exception("failed to delete local user data for %s", user_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete local user data",
        ) from exc

    return Response(status_code=status.HTTP_204_NO_CONTENT)
