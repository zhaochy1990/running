"""Notification storage — public interface (Tier A).

``DeviceEntity`` is the device row shape; ``NotificationEntity`` is a
user-scoped inbox item, and ``NotificationsBackend`` is the Protocol the file +
Azure Table backends satisfy (devices + prefs + inbox + read state). Pure
typing — no I/O import.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class DeviceEntity:
    user_id: str
    registration_id: str
    platform: str
    app_version: str | None
    last_seen_at: str
    created_at: str


@dataclass(frozen=True)
class NotificationEntity:
    user_id: str
    notification_id: str
    kind: str
    status: str
    severity: str
    title: str
    body: str
    published_at: str
    updated_at: str
    source_type: str | None = None
    source_id: str | None = None
    action_url: str | None = None
    progress_pct: int | None = None
    metadata: dict[str, Any] | None = None


class NotificationsBackend(Protocol):
    def upsert_device(self, entity: DeviceEntity) -> None: ...
    def delete_device(self, user_id: str, registration_id: str) -> bool: ...
    def list_devices(self, user_id: str) -> list[DeviceEntity]: ...
    def get_prefs(self, user_id: str) -> dict[str, Any]: ...
    def set_prefs(self, user_id: str, prefs: dict[str, Any]) -> dict[str, Any]: ...
    def get_read_notification_ids(self, user_id: str) -> list[str]: ...
    def set_read_notification_ids(
        self, user_id: str, notification_ids: list[str],
    ) -> list[str]: ...
    def get_read_notification_marks(self, user_id: str) -> dict[str, str]: ...
    def set_read_notification_marks(
        self, user_id: str, notification_marks: dict[str, str],
    ) -> dict[str, str]: ...
    def upsert_notification(self, entity: NotificationEntity) -> NotificationEntity: ...
    def get_notification(
        self, user_id: str, notification_id: str,
    ) -> NotificationEntity | None: ...
    def list_notifications(
        self, user_id: str, *, limit: int | None = None,
    ) -> list[NotificationEntity]: ...
    def list_users_with_prefs(self) -> list[str]: ...
