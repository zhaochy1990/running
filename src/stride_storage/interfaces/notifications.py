"""Notification storage — public interface (Tier A).

``DeviceEntity`` is the device row shape; ``NotificationsBackend`` is the
Protocol the file + Azure Table backends satisfy (devices + prefs + read
state). Pure typing — no I/O import.
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
    def list_users_with_prefs(self) -> list[str]: ...
