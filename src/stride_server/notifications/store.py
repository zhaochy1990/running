"""Notification storage — server-side facade.

The real implementation (file + Azure Table backends, ``DeviceEntity``,
validators, ``backend_from_config``) now lives in
``stride_storage.azure.notifications_backend``. This module keeps only the
*server* concerns: resolving ``NotificationStorageConfig`` from ``ServerConfig``
(including the STRIDE_LIKES legacy account-url fallback), caching the chosen
backend, and exposing the module-level functions the routes / cron call.

Re-exports the moved symbols so existing imports keep working unchanged.
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from typing import Any

from stride_server.config import clear_server_config_cache, load_server_config
from stride_server.config.loader import resolve_config_env
from stride_server.config.models import ConfigError, NotificationStorageConfig, ServerConfig
from stride_server.config.sources import env_source

# Implementation lives in stride_storage; re-exported for backward-compat.
from stride_storage.azure.notifications_backend import (  # noqa: F401  (re-export)
    DEFAULT_DEVICES_TABLE,
    DEFAULT_PREFS_TABLE,
    PREFS_ROW_KEY,
    READ_STATE_ROW_KEY,
    AzureTableNotificationsBackend,
    DeviceEntity,
    FileNotificationsBackend,
    backend_from_config,
    _now_iso,
    _validate_notification_id,
    _validate_registration_id,
    _validate_user_id,
)
from stride_storage.interfaces.notifications import NotificationsBackend  # noqa: F401

logger = logging.getLogger(__name__)

ACCOUNT_URL_ENV = "STRIDE_NOTIFICATIONS_TABLE_ACCOUNT_URL"
LEGACY_ACCOUNT_URL_ENV = "STRIDE_LIKES_TABLE_ACCOUNT_URL"
DEVICES_TABLE_ENV = "STRIDE_NOTIFICATIONS_DEVICES_TABLE"
PREFS_TABLE_ENV = "STRIDE_NOTIFICATIONS_PREFS_TABLE"


# ---------------------------------------------------------------------------
# Config resolution + cached backend (server policy — stays here)
# ---------------------------------------------------------------------------


def _is_auth_config_error(exc: ConfigError) -> bool:
    return "auth.public_key" in str(exc)


def _notification_config_from_env() -> NotificationStorageConfig:
    config = ServerConfig.default(env=resolve_config_env()).notifications
    notifications = env_source().get("notifications", {})
    if isinstance(notifications, dict):
        config = config.with_updates(**notifications)
    return _with_legacy_account_url(config)


def _with_legacy_account_url(config: NotificationStorageConfig) -> NotificationStorageConfig:
    if config.table_account_url.strip():
        return config
    legacy_account_url = os.environ.get(LEGACY_ACCOUNT_URL_ENV, "").strip()
    if not legacy_account_url:
        return config
    return config.with_updates(table_account_url=legacy_account_url)


def _notification_config() -> NotificationStorageConfig:
    try:
        return _with_legacy_account_url(load_server_config().notifications)
    except ConfigError as exc:
        if not _is_auth_config_error(exc):
            raise
        return _notification_config_from_env()


@lru_cache(maxsize=1)
def _get_backend() -> NotificationsBackend:
    return backend_from_config(_notification_config())


def reset_backend_cache() -> None:
    """Test helper — drop the cached backend so env changes take effect."""
    _get_backend.cache_clear()
    clear_server_config_cache()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def upsert_device(
    user_id: str,
    registration_id: str,
    *,
    platform: str,
    app_version: str | None,
) -> None:
    _validate_user_id(user_id)
    _validate_registration_id(registration_id)
    if platform not in ("android", "ios"):
        raise ValueError(f"invalid platform: {platform!r}")
    now = _now_iso()
    entity = DeviceEntity(
        user_id=user_id,
        registration_id=registration_id,
        platform=platform,
        app_version=app_version,
        last_seen_at=now,
        created_at=now,
    )
    _get_backend().upsert_device(entity)


def delete_device(user_id: str, registration_id: str) -> bool:
    _validate_user_id(user_id)
    _validate_registration_id(registration_id)
    return _get_backend().delete_device(user_id, registration_id)


def list_device_ids(user_id: str) -> list[str]:
    _validate_user_id(user_id)
    return [d.registration_id for d in _get_backend().list_devices(user_id)]


def get_prefs(user_id: str) -> dict[str, Any]:
    _validate_user_id(user_id)
    return _get_backend().get_prefs(user_id)


def get_read_notification_ids(user_id: str) -> list[str]:
    _validate_user_id(user_id)
    return _get_backend().get_read_notification_ids(user_id)


def mark_notification_read(user_id: str, notification_id: str) -> list[str]:
    _validate_user_id(user_id)
    notification_id = _validate_notification_id(notification_id)
    current = _get_backend().get_read_notification_ids(user_id)
    if notification_id in current:
        return current
    return _get_backend().set_read_notification_ids(user_id, [*current, notification_id])


def update_prefs(
    user_id: str,
    *,
    likes_enabled: bool | None = None,
    plan_reminder_enabled: bool | None = None,
    plan_reminder_time: str | None = None,
) -> dict[str, Any]:
    _validate_user_id(user_id)
    current = _get_backend().get_prefs(user_id)
    merged = {
        "likes_enabled": (
            likes_enabled if likes_enabled is not None else current["likes_enabled"]
        ),
        "plan_reminder_enabled": (
            plan_reminder_enabled
            if plan_reminder_enabled is not None
            else current["plan_reminder_enabled"]
        ),
        "plan_reminder_time": (
            plan_reminder_time
            if plan_reminder_time is not None
            else current["plan_reminder_time"]
        ),
    }
    return _get_backend().set_prefs(user_id, merged)


def list_users_with_prefs() -> list[str]:
    return _get_backend().list_users_with_prefs()
