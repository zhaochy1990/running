"""Watch management endpoints — view and disconnect the user's bound watch."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status

from stride_core.db import USER_DATA_DIR, Database
from stride_core.registry import ProviderRegistry, UnknownProvider

from ..bearer import require_bearer
from ..content_store import read_json, write_json

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


def _read_onboarding(uuid: str) -> dict[str, Any]:
    item = read_json(f"{uuid}/onboarding.json")
    if item is not None:
        data, _source = item
        if isinstance(data, dict):
            return data
    return {
        "coros_ready": False,
        "profile_ready": False,
        "completed_at": None,
        "sync_state": None,
        "sync_progress": None,
    }


def _write_onboarding(uuid: str, data: dict[str, Any]) -> None:
    write_json(f"{uuid}/onboarding.json", data)


def _get_watch_email(uuid: str, provider: str) -> str | None:
    """Read the account email from the provider's credential store.

    TODO: Replace with an adapter-level ``account_email(user)`` method
    when the DataSource protocol is extended. Currently reads credential
    files directly — coupled to COROS/Garmin storage layout.
    """
    if provider == "coros":
        config_path = USER_DATA_DIR / uuid / "config.json"
        if config_path.exists():
            try:
                data = json.loads(config_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return data.get("email") or None
            except (OSError, json.JSONDecodeError):
                pass
    elif provider == "garmin":
        garmin_path = USER_DATA_DIR / uuid / "garmin_auth.json"
        if garmin_path.exists():
            try:
                data = json.loads(garmin_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return data.get("email") or None
            except (OSError, json.JSONDecodeError):
                pass
    return None


def _get_device_and_last_sync(uuid: str) -> tuple[str | None, str | None]:
    """Query the latest watch model and last sync time from the user's DB."""
    try:
        db = Database(user=uuid)
    except Exception:
        return None, None

    device = None
    last_sync = None

    try:
        row = db._conn.execute(
            "SELECT device FROM activities WHERE device IS NOT NULL "
            "ORDER BY date DESC LIMIT 1"
        ).fetchone()
        if row:
            device = row[0]
    except Exception:
        pass

    try:
        row = db._conn.execute(
            "SELECT value FROM sync_meta WHERE key = 'last_sync'"
        ).fetchone()
        if row:
            last_sync = row[0]
    except Exception:
        pass

    if not last_sync:
        try:
            row = db._conn.execute(
                "SELECT date FROM activities ORDER BY date DESC LIMIT 1"
            ).fetchone()
            if row:
                last_sync = row[0]
        except Exception:
            pass

    return device, last_sync


@router.get("/api/users/me/watch")
def get_watch_info(
    request: Request,
    payload: dict = Depends(require_bearer),
):
    """Return the user's current watch connection info."""
    uuid = _validate_uuid(payload["sub"])

    registry: ProviderRegistry = request.app.state.registry
    try:
        source = registry.for_user(uuid)
    except UnknownProvider:
        return {
            "provider": None,
            "provider_display_name": None,
            "logged_in": False,
            "email": None,
            "device": None,
            "last_sync_at": None,
            "capabilities": [],
        }

    provider_info = source.info
    logged_in = source.is_logged_in(uuid)
    email = _get_watch_email(uuid, provider_info.name) if logged_in else None
    device, last_sync = _get_device_and_last_sync(uuid) if logged_in else (None, None)

    return {
        "provider": provider_info.name,
        "provider_display_name": provider_info.display_name,
        "logged_in": logged_in,
        "email": email,
        "device": device,
        "last_sync_at": last_sync,
        "capabilities": sorted(c.value for c in provider_info.capabilities),
    }


@router.delete("/api/users/me/watch")
def disconnect_watch(
    request: Request,
    payload: dict = Depends(require_bearer),
):
    """Disconnect the user's watch — clears credentials and resets onboarding."""
    uuid = _validate_uuid(payload["sub"])

    registry: ProviderRegistry = request.app.state.registry
    try:
        source = registry.for_user(uuid)
    except UnknownProvider:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No watch provider configured",
        )

    provider_name = source.info.name

    if not source.is_logged_in(uuid):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No watch currently connected",
        )

    # Clear adapter-specific credentials
    try:
        source.logout(uuid)
    except Exception:
        logger.exception("Watch logout failed for user %s", uuid)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to disconnect watch",
        )

    # Reset onboarding watch-ready flag so the user can re-bind.
    # The ``coros_ready`` key is the legacy provider-agnostic flag — it is
    # set to True for both COROS and Garmin users in onboarding.py (see the
    # "Reuse the existing onboarding flag" comment there).  Resetting it
    # here is correct regardless of which provider was disconnected.
    onboarding = _read_onboarding(uuid)
    onboarding["coros_ready"] = False
    onboarding["completed_at"] = None
    onboarding["sync_state"] = None
    onboarding["sync_progress"] = None
    _write_onboarding(uuid, onboarding)

    logger.info("Watch disconnected for user %s (provider=%s)", uuid, provider_name)
    return {"ok": True, "provider": provider_name}
