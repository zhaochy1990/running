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
from datetime import datetime, timedelta
from dataclasses import replace
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
from stride_storage.interfaces.notifications import (  # noqa: F401
    NotificationEntity,
    NotificationsBackend,
)

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


def delete_user(user_id: str) -> int:
    """Delete every device, preference, read-state, and inbox row for a user."""
    _validate_user_id(user_id)
    return _get_backend().delete_user(user_id)


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
    backend = _get_backend()
    read_ids = backend.get_read_notification_ids(user_id)
    seen = set(read_ids)
    for entity in backend.list_notifications(user_id):
        if _is_notification_read(entity) and entity.notification_id not in seen:
            read_ids.append(entity.notification_id)
            seen.add(entity.notification_id)
    return read_ids


def mark_notification_read(user_id: str, notification_id: str) -> list[str]:
    _validate_user_id(user_id)
    notification_id = _validate_notification_id(notification_id)
    backend = _get_backend()
    entity = backend.get_notification(user_id, notification_id)
    if entity is not None:
        backend.upsert_notification(replace(entity, read_at=entity.updated_at))
        return get_read_notification_ids(user_id)

    current = backend.get_read_notification_ids(user_id)
    if notification_id in current:
        return current
    backend.set_read_notification_ids(user_id, [*current, notification_id])
    return get_read_notification_ids(user_id)


def _is_notification_read(entity: NotificationEntity) -> bool:
    read_at = entity.read_at
    if not read_at:
        return False
    updated_at = entity.updated_at or entity.published_at
    return read_at >= updated_at


def _notification_to_dict(
    entity: NotificationEntity,
) -> dict[str, Any]:
    return {
        "id": entity.notification_id,
        "severity": entity.severity,
        "title": entity.title,
        "body": entity.body,
        "published_at": entity.published_at,
        "updated_at": entity.updated_at,
        "action_url": entity.action_url,
        "progress_pct": entity.progress_pct,
        "metadata": entity.metadata or {},
        "read": _is_notification_read(entity),
        "read_at": entity.read_at,
    }


def list_notifications(user_id: str, *, limit: int | None = None) -> list[dict[str, Any]]:
    _validate_user_id(user_id)
    backend = _get_backend()
    return [
        _notification_to_dict(entity)
        for entity in backend.list_notifications(user_id, limit=limit)
    ]


def _coerce_progress(value: int | None) -> int | None:
    if value is None:
        return None
    return max(0, min(100, int(value)))


def _updated_at_after(previous: str | None, current: str) -> str:
    if not previous or current > previous:
        return current
    try:
        return (datetime.fromisoformat(previous) + timedelta(microseconds=1)).isoformat(
            timespec="microseconds",
        )
    except ValueError:
        return current


def upsert_notification(
    user_id: str,
    notification_id: str,
    *,
    title: str,
    body: str,
    severity: str = "info",
    action_url: str | None = None,
    progress_pct: int | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    _validate_user_id(user_id)
    notification_id = _validate_notification_id(notification_id)
    if severity not in {"info", "success", "warning", "error"}:
        raise ValueError(f"invalid notification severity: {severity!r}")
    if not title.strip():
        raise ValueError("notification title is required")
    if not body.strip():
        raise ValueError("notification body is required")

    backend = _get_backend()
    existing = backend.get_notification(user_id, notification_id)
    now = _now_iso()
    updated_at = _updated_at_after(
        existing.updated_at or existing.published_at if existing is not None else None,
        now,
    )
    entity = NotificationEntity(
        user_id=user_id,
        notification_id=notification_id,
        severity=severity,
        title=title.strip()[:200],
        body=body.strip()[:2000],
        published_at=existing.published_at if existing is not None else now,
        updated_at=updated_at,
        read_at=existing.read_at if existing is not None else None,
        action_url=action_url,
        progress_pct=_coerce_progress(progress_pct),
        metadata=metadata or {},
    )
    saved = backend.upsert_notification(entity)
    return _notification_to_dict(saved)


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
