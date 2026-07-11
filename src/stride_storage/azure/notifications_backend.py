"""Notification storage backends (JSON file + Azure Table) + selection.

Devices + preferences + inbox items + read state. Per the SQLite scope rule
notification data is not watch-synced, so it lives in Azure Table (prod) /
JSON file (dev).
Two tables, one PartitionKey scheme (PK=user_id; RK=registration_id for
devices, "prefs"/"notification-read-state"/"notification:{id}" for prefs).

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
from stride_storage.interfaces.notifications import (
    DeviceEntity,
    NotificationEntity,
    NotificationsBackend,
)

logger = logging.getLogger(__name__)

DEFAULT_DEVICES_TABLE = "stridedevices"
DEFAULT_PREFS_TABLE = "strideprefs"

PREFS_ROW_KEY = "prefs"
READ_STATE_ROW_KEY = "notification-read-state"
NOTIFICATION_ROW_PREFIX = "notification:"

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
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _notification_to_record(entity: NotificationEntity) -> dict[str, Any]:
    return {
        "kind": entity.kind,
        "status": entity.status,
        "severity": entity.severity,
        "title": entity.title,
        "body": entity.body,
        "published_at": entity.published_at,
        "updated_at": entity.updated_at,
        "source_type": entity.source_type,
        "source_id": entity.source_id,
        "action_url": entity.action_url,
        "progress_pct": entity.progress_pct,
        "metadata": entity.metadata or {},
    }


def _notification_from_record(
    user_id: str,
    notification_id: str,
    record: dict[str, Any],
) -> NotificationEntity:
    metadata = record.get("metadata")
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except (TypeError, ValueError):
            metadata = {}
    if not isinstance(metadata, dict):
        metadata = {}

    progress = record.get("progress_pct")
    try:
        progress_pct = int(progress) if progress is not None else None
    except (TypeError, ValueError):
        progress_pct = None

    return NotificationEntity(
        user_id=user_id,
        notification_id=notification_id,
        kind=str(record.get("kind") or "general"),
        status=str(record.get("status") or "info"),
        severity=str(record.get("severity") or "info"),
        title=str(record.get("title") or ""),
        body=str(record.get("body") or ""),
        published_at=str(record.get("published_at") or record.get("updated_at") or ""),
        updated_at=str(record.get("updated_at") or record.get("published_at") or ""),
        source_type=record.get("source_type") or None,
        source_id=record.get("source_id") or None,
        action_url=record.get("action_url") or None,
        progress_pct=progress_pct,
        metadata=metadata,
    )


def _read_marks_from_record(record: dict[str, Any]) -> dict[str, str]:
    raw_marks = record.get("read_marks") or record.get("read_marks_json")
    if isinstance(raw_marks, str):
        try:
            raw_marks = json.loads(raw_marks)
        except (TypeError, ValueError):
            raw_marks = {}
    if isinstance(raw_marks, dict):
        return {
            str(k): str(v)
            for k, v in raw_marks.items()
            if isinstance(k, str) and isinstance(v, str)
        }

    raw_ids = record.get("read_ids") or record.get("read_ids_json")
    if isinstance(raw_ids, str):
        try:
            raw_ids = json.loads(raw_ids)
        except (TypeError, ValueError):
            raw_ids = []
    if isinstance(raw_ids, list):
        return {item: "" for item in raw_ids if isinstance(item, str)}
    return {}


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
            return {"devices": {}, "prefs": {}, "read_state": {}, "notifications": {}}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"devices": {}, "prefs": {}, "read_state": {}, "notifications": {}}
        data.setdefault("devices", {})
        data.setdefault("prefs", {})
        data.setdefault("read_state", {})
        data.setdefault("notifications", {})
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
        return list(self.get_read_notification_marks(user_id).keys())

    def get_read_notification_marks(self, user_id: str) -> dict[str, str]:
        data = self._read()
        rec = data["read_state"].get(user_id, {})
        if not isinstance(rec, dict):
            return {}
        return _read_marks_from_record(rec)

    def set_read_notification_ids(self, user_id: str, notification_ids: list[str]) -> list[str]:
        now = _now_iso()
        self.set_read_notification_marks(
            user_id,
            {item: now for item in notification_ids if isinstance(item, str)},
        )
        return self.get_read_notification_ids(user_id)

    def set_read_notification_marks(self, user_id: str, notification_marks: dict[str, str]) -> dict[str, str]:
        with self._lock:
            data = self._read()
            marks = {
                k: v for k, v in notification_marks.items()
                if isinstance(k, str) and isinstance(v, str)
            }
            data["read_state"][user_id] = {
                "read_ids": list(marks.keys()),
                "read_marks": marks,
                "updated_at": _now_iso(),
            }
            self._write(data)
        return self.get_read_notification_marks(user_id)

    def upsert_notification(self, entity: NotificationEntity) -> NotificationEntity:
        with self._lock:
            data = self._read()
            user_items = data["notifications"].setdefault(entity.user_id, {})
            user_items[entity.notification_id] = _notification_to_record(entity)
            self._write(data)
        return entity

    def get_notification(self, user_id: str, notification_id: str) -> NotificationEntity | None:
        data = self._read()
        record = data["notifications"].get(user_id, {}).get(notification_id)
        if not isinstance(record, dict):
            return None
        return _notification_from_record(user_id, notification_id, record)

    def list_notifications(
        self, user_id: str, *, limit: int | None = None
    ) -> list[NotificationEntity]:
        data = self._read()
        rows = data["notifications"].get(user_id, {})
        out: list[NotificationEntity] = []
        for notification_id, record in rows.items():
            if isinstance(notification_id, str) and isinstance(record, dict):
                out.append(_notification_from_record(user_id, notification_id, record))
        out.sort(key=lambda n: (n.updated_at or n.published_at, n.notification_id), reverse=True)
        if limit is not None:
            return out[: max(0, limit)]
        return out

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
        return list(self.get_read_notification_marks(user_id).keys())

    def get_read_notification_marks(self, user_id: str) -> dict[str, str]:
        from azure.core.exceptions import ResourceNotFoundError
        try:
            row = self._prefs().get_entity(
                partition_key=user_id, row_key=READ_STATE_ROW_KEY,
            )
        except ResourceNotFoundError:
            return {}
        return _read_marks_from_record(dict(row))

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
        now = _now_iso()
        self.set_read_notification_marks(
            user_id,
            {item: now for item in notification_ids if isinstance(item, str)},
        )
        return self.get_read_notification_ids(user_id)

    def set_read_notification_marks(self, user_id: str, notification_marks: dict[str, str]) -> dict[str, str]:
        from azure.data.tables import UpdateMode
        marks = {
            k: v for k, v in notification_marks.items()
            if isinstance(k, str) and isinstance(v, str)
        }
        record = {
            "PartitionKey": user_id,
            "RowKey": READ_STATE_ROW_KEY,
            "read_ids_json": json.dumps(list(marks.keys()), ensure_ascii=False),
            "read_marks_json": json.dumps(marks, ensure_ascii=False),
            "updated_at": _now_iso(),
        }
        self._prefs().upsert_entity(record, mode=UpdateMode.REPLACE)
        return self.get_read_notification_marks(user_id)

    def upsert_notification(self, entity: NotificationEntity) -> NotificationEntity:
        from azure.data.tables import UpdateMode

        record = {
            "PartitionKey": entity.user_id,
            "RowKey": NOTIFICATION_ROW_PREFIX + entity.notification_id,
            "kind": entity.kind,
            "status": entity.status,
            "severity": entity.severity,
            "title": entity.title,
            "body": entity.body,
            "published_at": entity.published_at,
            "updated_at": entity.updated_at,
            "source_type": entity.source_type or "",
            "source_id": entity.source_id or "",
            "action_url": entity.action_url or "",
            "metadata_json": json.dumps(entity.metadata or {}, ensure_ascii=False, default=str),
        }
        if entity.progress_pct is not None:
            record["progress_pct"] = entity.progress_pct
        self._prefs().upsert_entity(record, mode=UpdateMode.REPLACE)
        return entity

    def get_notification(self, user_id: str, notification_id: str) -> NotificationEntity | None:
        from azure.core.exceptions import ResourceNotFoundError
        try:
            row = self._prefs().get_entity(
                partition_key=user_id,
                row_key=NOTIFICATION_ROW_PREFIX + notification_id,
            )
        except ResourceNotFoundError:
            return None
        record = dict(row)
        record["metadata"] = record.get("metadata_json")
        return _notification_from_record(user_id, notification_id, record)

    def list_notifications(
        self, user_id: str, *, limit: int | None = None
    ) -> list[NotificationEntity]:
        rows = list(self._prefs().query_entities(
            "PartitionKey eq @pk",
            parameters={"pk": user_id},
        ))
        out: list[NotificationEntity] = []
        for row in rows:
            row_key = row.get("RowKey") or ""
            if not isinstance(row_key, str) or not row_key.startswith(NOTIFICATION_ROW_PREFIX):
                continue
            notification_id = row_key[len(NOTIFICATION_ROW_PREFIX):]
            record = dict(row)
            record["metadata"] = record.get("metadata_json")
            out.append(_notification_from_record(user_id, notification_id, record))
        out.sort(key=lambda n: (n.updated_at or n.published_at, n.notification_id), reverse=True)
        if limit is not None:
            return out[: max(0, limit)]
        return out

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
