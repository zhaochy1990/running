"""Notification storage backend — devices + preferences.

Per the SQLite scope rule (CLAUDE.md): notification data does NOT come from
a watch sync, so it lives in **Azure Table Storage**, not SQLite. Mirrors
the dual-backend pattern from ``stride_server.likes_store``: a JSON file
under ``data/.notifications.json`` for offline dev, an Azure Tables backend
for prod (auth via ``DefaultAzureCredential``).

Two logical tables, one PartitionKey scheme:

    Table:     stridedevices         strideprefs
    PK:        user_id               user_id
    RK:        registration_id       "prefs"   (singleton)

Env vars (shared with likes_store on the same storage account):
    STRIDE_NOTIFICATIONS_TABLE_ACCOUNT_URL
        e.g. https://authstorage2026.table.core.windows.net
        Falls back to STRIDE_LIKES_TABLE_ACCOUNT_URL if the dedicated var
        isn't set, since both wire to the same Azure Storage account.
    STRIDE_NOTIFICATIONS_DEVICES_TABLE   default ``stridedevices``
    STRIDE_NOTIFICATIONS_PREFS_TABLE     default ``strideprefs``
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from stride_core import db as core_db

logger = logging.getLogger(__name__)

ACCOUNT_URL_ENV = "STRIDE_NOTIFICATIONS_TABLE_ACCOUNT_URL"
LEGACY_ACCOUNT_URL_ENV = "STRIDE_LIKES_TABLE_ACCOUNT_URL"
DEVICES_TABLE_ENV = "STRIDE_NOTIFICATIONS_DEVICES_TABLE"
PREFS_TABLE_ENV = "STRIDE_NOTIFICATIONS_PREFS_TABLE"
DEFAULT_DEVICES_TABLE = "stridedevices"
DEFAULT_PREFS_TABLE = "strideprefs"

PREFS_ROW_KEY = "prefs"

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_REG_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{8,200}$")


def _validate_user_id(user_id: str) -> str:
    if not isinstance(user_id, str) or not _UUID4_RE.match(user_id):
        raise ValueError(f"invalid user_id: {user_id!r}")
    return user_id


def _validate_registration_id(reg_id: str) -> str:
    if not isinstance(reg_id, str) or not _REG_ID_RE.match(reg_id):
        raise ValueError(f"invalid registration_id: {reg_id!r}")
    return reg_id


_DEFAULT_PREFS: dict[str, Any] = {
    "likes_enabled": True,
    "plan_reminder_enabled": True,
    "plan_reminder_time": "08:00",
}


@dataclass(frozen=True)
class DeviceEntity:
    user_id: str
    registration_id: str
    platform: str
    app_version: str | None
    last_seen_at: str
    created_at: str


# ---------------------------------------------------------------------------
# Backend interface
# ---------------------------------------------------------------------------


class _Backend:
    def upsert_device(self, entity: DeviceEntity) -> None: ...
    def delete_device(self, user_id: str, registration_id: str) -> bool: ...
    def list_devices(self, user_id: str) -> list[DeviceEntity]: ...
    def get_prefs(self, user_id: str) -> dict[str, Any]: ...
    def set_prefs(self, user_id: str, prefs: dict[str, Any]) -> dict[str, Any]: ...
    def list_users_with_prefs(self) -> list[str]:
        """Used by the plan-reminder cron job to enumerate users."""
        ...


# ---------------------------------------------------------------------------
# File backend (dev / tests)
# ---------------------------------------------------------------------------


def _file_path() -> Path:
    return core_db.USER_DATA_DIR / ".notifications.json"


class _FileBackend(_Backend):
    """JSON file at ``data/.notifications.json``.

    Schema:
        {
          "devices": { "<user_id>": { "<registration_id>": { ... } } },
          "prefs":   { "<user_id>": { "likes_enabled": bool, ... } }
        }
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()

    def _read(self) -> dict[str, dict]:
        path = _file_path()
        if not path.exists():
            return {"devices": {}, "prefs": {}}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"devices": {}, "prefs": {}}
        data.setdefault("devices", {})
        data.setdefault("prefs", {})
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

    def list_users_with_prefs(self) -> list[str]:
        return list(self._read()["prefs"].keys())


# ---------------------------------------------------------------------------
# Azure Table backend
# ---------------------------------------------------------------------------


class _AzureTableBackend(_Backend):
    def __init__(
        self,
        account_url: str,
        devices_table: str,
        prefs_table: str,
    ) -> None:
        self._account_url = account_url
        self._devices_table_name = devices_table
        self._prefs_table_name = prefs_table
        self._devices_client = None
        self._prefs_client = None
        self._lock = threading.Lock()

    def _service(self):
        from azure.data.tables import TableServiceClient
        from azure.identity import DefaultAzureCredential
        return TableServiceClient(
            endpoint=self._account_url,
            credential=DefaultAzureCredential(),
        )

    def _ensure_client(self, name: str, attr: str):
        existing = getattr(self, attr)
        if existing is not None:
            return existing
        with self._lock:
            existing = getattr(self, attr)
            if existing is not None:
                return existing
            from azure.core.exceptions import ResourceExistsError
            service = self._service()
            try:
                service.create_table(name)
            except ResourceExistsError:
                pass
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "notifications.store: create_table %s failed: %s", name, exc,
                )
            client = service.get_table_client(name)
            setattr(self, attr, client)
            return client

    def _devices(self):
        return self._ensure_client(self._devices_table_name, "_devices_client")

    def _prefs(self):
        return self._ensure_client(self._prefs_table_name, "_prefs_client")

    def upsert_device(self, entity: DeviceEntity) -> None:
        from azure.data.tables import UpdateMode
        client = self._devices()
        record = {
            "PartitionKey": entity.user_id,
            "RowKey": entity.registration_id,
            "platform": entity.platform,
            "app_version": entity.app_version or "",
            "last_seen_at": entity.last_seen_at,
            "created_at": entity.created_at,
        }
        client.upsert_entity(record, mode=UpdateMode.MERGE)

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

    def list_users_with_prefs(self) -> list[str]:
        # Each user has exactly one prefs row (RowKey="prefs"), so we can
        # filter to that and project just PartitionKey. This stays cheap
        # even at thousands of users.
        rows = list(self._prefs().query_entities(
            "RowKey eq @rk",
            parameters={"rk": PREFS_ROW_KEY},
            select=["PartitionKey"],
        ))
        return [r["PartitionKey"] for r in rows if r.get("PartitionKey")]


# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def _get_backend() -> _Backend:
    account_url = (
        os.environ.get(ACCOUNT_URL_ENV, "").strip()
        or os.environ.get(LEGACY_ACCOUNT_URL_ENV, "").strip()
    )
    devices_table = (
        os.environ.get(DEVICES_TABLE_ENV, "").strip() or DEFAULT_DEVICES_TABLE
    )
    prefs_table = (
        os.environ.get(PREFS_TABLE_ENV, "").strip() or DEFAULT_PREFS_TABLE
    )
    if account_url:
        logger.info(
            "notifications.store: Azure Tables backend devices=%s prefs=%s",
            devices_table, prefs_table,
        )
        return _AzureTableBackend(account_url, devices_table, prefs_table)
    logger.info(
        "notifications.store: file backend at %s", _file_path(),
    )
    return _FileBackend()


def reset_backend_cache() -> None:
    """Test helper — drop the cached backend so env changes take effect."""
    _get_backend.cache_clear()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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
