"""Shared onboarding JSON state used by API routes."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from .content_store import read_json, write_json

logger = logging.getLogger(__name__)


def _path(user_id: str) -> str:
    return f"{user_id}/onboarding.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read(user_id: str) -> dict[str, Any]:
    item = read_json(_path(user_id))
    if item is not None:
        data, source = item
        if isinstance(data, dict):
            logger.info("onboarding read user=%s source=%s", user_id, source)
            return data
        logger.warning(
            "onboarding read ignored non-object JSON for user=%s source=%s",
            user_id,
            source,
        )
    return {
        "coros_ready": False,
        "profile_ready": False,
        "completed_at": None,
        "sync_state": None,
        "sync_progress": None,
    }


def write(user_id: str, data: dict[str, Any]) -> None:
    source = write_json(_path(user_id), data)
    logger.info("onboarding write user=%s source=%s", user_id, source)
