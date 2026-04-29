"""Self-service account deletion endpoints."""

from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status

from stride_core.db import USER_DATA_DIR

from .. import auth_service_client as auth_client
from ..bearer import current_user_id, require_bearer

logger = logging.getLogger(__name__)

router = APIRouter()

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


def _delete_local_user_data(user_id: str) -> None:
    path = _user_data_path(user_id)
    if not path.exists():
        return
    if not path.is_dir():
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="User data path is not a directory",
        )
    shutil.rmtree(path)


@router.delete("/api/users/me", status_code=status.HTTP_204_NO_CONTENT)
async def delete_my_account(
    authorization: str | None = Header(default=None),
    claims: dict = Depends(require_bearer),
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
        _delete_local_user_data(user_id)
    except OSError as exc:
        logger.exception("failed to delete local user data for %s", user_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete local user data",
        ) from exc

    return Response(status_code=status.HTTP_204_NO_CONTENT)
