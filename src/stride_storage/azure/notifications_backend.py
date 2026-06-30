"""Notification storage backends (JSON file + Azure Table) + selection.

Devices + preferences + read state. Per the SQLite scope rule notification
data is not watch-synced, so it lives in Azure Table (prod) / JSON file (dev).
Two tables, one PartitionKey scheme (PK=user_id; RK=registration_id for
devices, "prefs"/"notification-read-state" for prefs).

Config *loading* (incl. the STRIDE_LIKES legacy account-url fallback) stays in
``stride_server``; this module takes a resolved ``NotificationStorageConfig``.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from stride_core import db as core_db
from stride_storage.azure.backend_select import choose_backend
from stride_storage.azure.table_backend import AzureTableConnection
from stride_storage.interfaces.config import NotificationStorageConfig
from stride_storage.interfaces.notifications import DeviceEntity, NotificationsBackend

logger = logging.getLogger(__name__)

DEFAULT_DEVICES_TABLE = "stridedevices"
DEFAULT_PREFS_TABLE = "strideprefs"

PREFS_ROW_KEY = "prefs"
READ_STATE_ROW_KEY = "notification-read-state"

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_REG_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{8,200}$")
_NOTIFICATION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,127}$")


def _validate_user_id(user_id: str) -> str:
    if not isinstance(user_id, str) or not _UUID4_RE.match(user_id):
        raise ValueError(f"invalid user_id: {user_id!r}")
    return user_id


def _validate_registration_id(reg_id: str) -> str:
    if not isinstance(reg_id, str) or not _REG_ID_RE.match(reg_id):
        raise ValueError(f"invalid registration_id: {reg_id!r}")
    return reg_id


def _validate_notification_id(notification_id: str) -> str:
    if not isinstance(notification_id, str) or not _NOTIFICATION_ID_RE.match(notification_id):
        raise ValueError(f"invalid notification_id: {notification_id!r}")
    return notification_id


_DEFAULT_PREFS: dict[str, Any] = {
    "likes_enabled": True,
    "plan_reminder_enabled": True,
    "plan_reminder_time": "08:00",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# File backend (dev / tests)
# ---------------------------------------------------------------------------


def _file_path() -> Path:
    return core_db.USER_DATA_DIR / ".notifications.json"


class FileNotificationsBackend(NotificationsBackend):
    """JSON file at ``data/.notifications.json`` (devices / prefs / read_state)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    def _read(self) -> dict[str, dict]:
        path = _file_path()
        if not path.exists():
            return {"devices": {}, "prefs": {}, "read_state": {}}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"devices": {}, "prefs": {}, "read_state": {}}
        data.setdefault("devices", {})
        data.setdefault("prefs", {})
        data.setdefault("read_state", {})
        return data

    def _write(self, data: dict[str, dict]) -> None:
        path = _file_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(
            json.dumps(data, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        os.replace(tmp, path)

    def upsert_device(self, entity: DeviceEntity) -> None:
        with self._lock:
            data = self._read()
            user_devs = data["devices"].setdefault(entity.user_id, {})
            user_devs[entity.registration_id] = {
                "platform": entity.platform,
                "app_version": entity.app_version,
                "last_seen_at": entity.last_seen_at,
                "created_at": user_devs.get(entity.registration_id, {}).get(
                    "created_at"
                )
                or entity.created_at,
            }
            self._write(data)

    def delete_device(self, user_id: str, registration_id: str) -> bool:
        with self._lock:
            data = self._read()
            user_devs = data["devices"].get(user_id, {})
            if registration_id not in user_devs:
                return False
            del user_devs[registration_id]
            if not user_devs:
                data["devices"].pop(user_id, None)
            self._write(data)
            return True

    def list_devices(self, user_id: str) -> list[DeviceEntity]:
        data = self._read()
        rows = data["devices"].get(user_id, {})
        out = []
        for reg_id, props in rows.items():
            out.append(DeviceEntity(
                user_id=user_id,
                registration_id=reg_id,
                platform=props.get("platform", "android"),
                app_version=props.get("app_version"),
                last_seen_at=props.get("last_seen_at", ""),
                created_at=props.get("created_at", ""),
            ))
        out.sort(key=lambda d: d.last_seen_at, reverse=True)
        return out

    def get_prefs(self, user_id: str) -> dict[str, Any]:
        data = self._read()
        rec = data["prefs"].get(user_id)
        if rec is None:
            return {**_DEFAULT_PREFS, "updated_at": None}
        return {
            "likes_enabled": bool(rec.get("likes_enabled", True)),
            "plan_reminder_enabled": bool(rec.get("plan_reminder_enabled", True)),
            "plan_reminder_time": rec.get("plan_reminder_time", "08:00"),
            "updated_at": rec.get("updated_at"),
        }

    def set_prefs(self, user_id: str, prefs: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            data = self._read()
            data["prefs"][user_id] = {
                **prefs,
                "updated_at": _now_iso(),
            }
            self._write(data)
        return self.get_prefs(user_id)

    def get_read_notification_ids(self, user_id: str) -> list[str]:
        data = self._read()
        rec = data["read_state"].get(user_id, {})
        ids = rec.get("read_ids", [])
        if not isinstance(ids, list):
            return []
        return [item for item in ids if isinstance(item, str)]

    def set_read_notification_ids(self, user_id: str, notification_ids: list[str]) -> list[str]:
        with self._lock:
            data = self._read()
            data["read_state"][user_id] = {
                "read_ids": notification_ids,
                "updated_at": _now_iso(),
            }
            self._write(data)
        return self.get_read_notification_ids(user_id)

    def list_users_with_prefs(self) -> list[str]:
        return list(self._read()["prefs"].keys())


# ---------------------------------------------------------------------------
# Azure Table backend
# ---------------------------------------------------------------------------


class AzureTableNotificationsBackend(NotificationsBackend):
    def __init__(
        self,
        account_url: str,
        devices_table: str,
        prefs_table: str,
    ) -> None:
        self._devices_conn = AzureTableConnection(account_url, devices_table)
        self._prefs_conn = AzureTableConnection(account_url, prefs_table)

    def _devices(self):
        return self._devices_conn.table()

    def _prefs(self):
        return self._prefs_conn.table()

    def upsert_device(self, entity: DeviceEntity) -> None:
        from azure.data.tables import UpdateMode
        record = {
            "PartitionKey": entity.user_id,
            "RowKey": entity.registration_id,
            "platform": entity.platform,
            "app_version": entity.app_version or "",
            "last_seen_at": entity.last_seen_at,
            "created_at": entity.created_at,
        }
        self._devices().upsert_entity(record, mode=UpdateMode.MERGE)

    def delete_device(self, user_id: str, registration_id: str) -> bool:
        from azure.core.exceptions import ResourceNotFoundError
        try:
            self._devices().delete_entity(
                partition_key=user_id, row_key=registration_id,
            )
            return True
        except ResourceNotFoundError:
            return False

    def list_devices(self, user_id: str) -> list[DeviceEntity]:
        rows = list(self._devices().query_entities(
            "PartitionKey eq @pk",
            parameters={"pk": user_id},
        ))
        out = []
        for r in rows:
            out.append(DeviceEntity(
                user_id=user_id,
                registration_id=r.get("RowKey", ""),
                platform=r.get("platform", "android"),
                app_version=r.get("app_version") or None,
                last_seen_at=r.get("last_seen_at", ""),
                created_at=r.get("created_at", ""),
            ))
        out.sort(key=lambda d: d.last_seen_at, reverse=True)
        return out

    def get_prefs(self, user_id: str) -> dict[str, Any]:
        from azure.core.exceptions import ResourceNotFoundError
        try:
            row = self._prefs().get_entity(
                partition_key=user_id, row_key=PREFS_ROW_KEY,
            )
        except ResourceNotFoundError:
            return {**_DEFAULT_PREFS, "updated_at": None}
        return {
            "likes_enabled": bool(row.get("likes_enabled", True)),
            "plan_reminder_enabled": bool(row.get("plan_reminder_enabled", True)),
            "plan_reminder_time": row.get("plan_reminder_time", "08:00"),
            "updated_at": row.get("updated_at"),
        }

    def get_read_notification_ids(self, user_id: str) -> list[str]:
        from azure.core.exceptions import ResourceNotFoundError
        try:
            row = self._prefs().get_entity(
                partition_key=user_id, row_key=READ_STATE_ROW_KEY,
            )
        except ResourceNotFoundError:
            return []
        raw = row.get("read_ids_json", "[]")
        try:
            ids = json.loads(raw)
        except (TypeError, ValueError):
            return []
        if not isinstance(ids, list):
            return []
        return [item for item in ids if isinstance(item, str)]

    def set_prefs(self, user_id: str, prefs: dict[str, Any]) -> dict[str, Any]:
        from azure.data.tables import UpdateMode
        record = {
            "PartitionKey": user_id,
            "RowKey": PREFS_ROW_KEY,
            "likes_enabled": bool(prefs.get("likes_enabled", True)),
            "plan_reminder_enabled": bool(
                prefs.get("plan_reminder_enabled", True)
            ),
            "plan_reminder_time": prefs.get("plan_reminder_time", "08:00"),
            "updated_at": _now_iso(),
        }
        self._prefs().upsert_entity(record, mode=UpdateMode.REPLACE)
        return self.get_prefs(user_id)

    def set_read_notification_ids(self, user_id: str, notification_ids: list[str]) -> list[str]:
        from azure.data.tables import UpdateMode
        record = {
            "PartitionKey": user_id,
            "RowKey": READ_STATE_ROW_KEY,
            "read_ids_json": json.dumps(notification_ids, ensure_ascii=False),
            "updated_at": _now_iso(),
        }
        self._prefs().upsert_entity(record, mode=UpdateMode.REPLACE)
        return self.get_read_notification_ids(user_id)

    def list_users_with_prefs(self) -> list[str]:
        # Each user has exactly one prefs row (RowKey="prefs"), so filter to
        # that and project just PartitionKey. Cheap even at thousands of users.
        rows = list(self._prefs().query_entities(
            "RowKey eq @rk",
            parameters={"rk": PREFS_ROW_KEY},
            select=["PartitionKey"],
        ))
        return [r["PartitionKey"] for r in rows if r.get("PartitionKey")]


# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------


def backend_from_config(config: NotificationStorageConfig) -> NotificationsBackend:
    account_url = config.table_account_url.strip()
    devices_table = config.devices_table.strip() or DEFAULT_DEVICES_TABLE
    prefs_table = config.prefs_table.strip() or DEFAULT_PREFS_TABLE

    def _azure() -> NotificationsBackend:
        logger.info(
            "notifications.store: Azure Tables backend devices=%s prefs=%s",
            devices_table, prefs_table,
        )
        return AzureTableNotificationsBackend(account_url, devices_table, prefs_table)

    def _file() -> NotificationsBackend:
        logger.info("notifications.store: file backend at %s", _file_path())
        return FileNotificationsBackend()

    return choose_backend(account_url, azure_factory=_azure, file_factory=_file)
