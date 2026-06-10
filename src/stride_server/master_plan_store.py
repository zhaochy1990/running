"""MasterPlan storage backend (Azure Table + JSON file dual-backend).

This module follows the exact same dual-backend pattern as ``likes_store.py``:

- **Azure Table Storage** (prod): two tables —
  - ``stridemasterplan``   (PartitionKey=user_id, RowKey=plan_id)
  - ``stridemasterplanversions``  (PartitionKey=plan_id, RowKey=version_id)
- **JSON file** (dev / tests, no Azure creds needed): two files —
  - ``data/.master_plans.json``
  - ``data/.master_plan_versions.json``

Env vars:
    STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL   e.g. https://authstorage2026.table.core.windows.net
    STRIDE_MASTER_PLAN_TABLE_NAME          default ``stridemasterplan``
                                           (versions table = <name>versions)

If ``STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL`` is unset the module falls back to
the JSON file backend — unit tests + offline dev work without Azure.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from functools import lru_cache
from pathlib import Path
from typing import Protocol, runtime_checkable

from stride_core import db as core_db
from stride_core.master_plan import MasterPlan, MasterPlanStatus, MasterPlanVersion
from stride_server.config import clear_server_config_cache, load_server_config
from stride_server.config.loader import resolve_config_env
from stride_server.config.models import ConfigError, MasterPlanStorageConfig, ServerConfig
from stride_server.config.sources import env_source

logger = logging.getLogger(__name__)

ACCOUNT_URL_ENV = "STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL"
TABLE_NAME_ENV = "STRIDE_MASTER_PLAN_TABLE_NAME"
DEFAULT_TABLE_NAME = "stridemasterplan"


# ---------------------------------------------------------------------------
# Protocol (public interface, also useful for mocking in tests)
# ---------------------------------------------------------------------------


@runtime_checkable
class MasterPlanStore(Protocol):
    def save_plan(self, plan: MasterPlan) -> None: ...
    def get_plan(self, user_id: str, plan_id: str) -> MasterPlan | None: ...
    def get_active_plan(self, user_id: str) -> MasterPlan | None: ...
    def list_plans(self, user_id: str) -> list[MasterPlan]: ...
    def archive_previous(self, user_id: str, new_plan_id: str) -> None: ...
    def save_version(self, version: MasterPlanVersion) -> None: ...
    def list_versions(self, plan_id: str) -> list[MasterPlanVersion]: ...
    def get_version(self, plan_id: str, version_id: str) -> MasterPlanVersion | None: ...


# ---------------------------------------------------------------------------
# File backend helpers
# ---------------------------------------------------------------------------


def _plans_file() -> Path:
    return core_db.USER_DATA_DIR / ".master_plans.json"


def _versions_file() -> Path:
    return core_db.USER_DATA_DIR / ".master_plan_versions.json"


def _read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# File backend
# ---------------------------------------------------------------------------


class FileMasterPlanStore:
    """JSON-file-backed store for tests and offline dev.

    Structure of ``.master_plans.json``:
        {
          "<user_id>": {
            "<plan_id>": { ...MasterPlan fields... }
          }
        }

    Structure of ``.master_plan_versions.json``:
        {
          "<plan_id>": {
            "<version_id>": { ...MasterPlanVersion fields... }
          }
        }
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()

    # -- Plans ----------------------------------------------------------------

    def save_plan(self, plan: MasterPlan) -> None:
        with self._lock:
            data = _read_json(_plans_file())
            user_bucket = data.setdefault(plan.user_id, {})
            user_bucket[plan.plan_id] = json.loads(plan.model_dump_json())
            _write_json(_plans_file(), data)

    def get_plan(self, user_id: str, plan_id: str) -> MasterPlan | None:
        data = _read_json(_plans_file())
        raw = data.get(user_id, {}).get(plan_id)
        if raw is None:
            return None
        return MasterPlan.model_validate(raw)

    def get_active_plan(self, user_id: str) -> MasterPlan | None:
        data = _read_json(_plans_file())
        for raw in data.get(user_id, {}).values():
            if raw.get("status") == MasterPlanStatus.ACTIVE.value:
                return MasterPlan.model_validate(raw)
        return None

    def list_plans(self, user_id: str) -> list[MasterPlan]:
        data = _read_json(_plans_file())
        return [
            MasterPlan.model_validate(raw)
            for raw in data.get(user_id, {}).values()
        ]

    def archive_previous(self, user_id: str, new_plan_id: str) -> None:
        """Set status=ARCHIVED on every plan for *user_id* except *new_plan_id*."""
        with self._lock:
            data = _read_json(_plans_file())
            for pid, raw in data.get(user_id, {}).items():
                if pid != new_plan_id and raw.get("status") != MasterPlanStatus.ARCHIVED.value:
                    raw["status"] = MasterPlanStatus.ARCHIVED.value
            _write_json(_plans_file(), data)

    # -- Versions -------------------------------------------------------------

    def save_version(self, version: MasterPlanVersion) -> None:
        with self._lock:
            data = _read_json(_versions_file())
            plan_bucket = data.setdefault(version.plan_id, {})
            plan_bucket[version.version_id] = json.loads(version.model_dump_json())
            _write_json(_versions_file(), data)

    def list_versions(self, plan_id: str) -> list[MasterPlanVersion]:
        data = _read_json(_versions_file())
        versions = [
            MasterPlanVersion.model_validate(raw)
            for raw in data.get(plan_id, {}).values()
        ]
        # Descending by version number (latest first)
        versions.sort(key=lambda v: v.version, reverse=True)
        return versions

    def get_version(self, plan_id: str, version_id: str) -> MasterPlanVersion | None:
        data = _read_json(_versions_file())
        raw = data.get(plan_id, {}).get(version_id)
        if raw is None:
            return None
        return MasterPlanVersion.model_validate(raw)


# ---------------------------------------------------------------------------
# Azure Table backend
# ---------------------------------------------------------------------------


class AzureTableMasterPlanStore:
    """Azure Table Storage backed store (prod).

    Plans table  (``stridemasterplan``):
        PartitionKey = user_id
        RowKey       = plan_id
        kind         = "plan"
        status       = plan.status value
        version      = plan.version (int)
        start_date   = plan.start_date
        end_date     = plan.end_date
        total_weeks  = plan.total_weeks
        plan_json    = plan.model_dump_json()
        created_at   = plan.created_at
        updated_at   = plan.updated_at

    Versions table  (``stridemasterplanversions``):
        PartitionKey  = plan_id
        RowKey        = version_id
        kind          = "version"
        version       = version.version (int)
        changed_at    = version.changed_at
        change_reason = version.change_reason
        change_summary= version.change_summary
        snapshot_json = version.snapshot_json
    """

    def __init__(self, account_url: str, table_name: str) -> None:
        self._account_url = account_url
        self._plans_table_name = table_name
        self._versions_table_name = table_name + "versions"
        self._plans_client = None
        self._versions_client = None
        self._lock = threading.Lock()

    def _get_client(self, table_name: str, attr: str):
        """Lazy thread-safe TableClient initialisation (mirrors likes_store pattern)."""
        client = getattr(self, attr)
        if client is not None:
            return client
        with self._lock:
            client = getattr(self, attr)
            if client is not None:
                return client
            from azure.core.exceptions import ResourceExistsError
            from azure.data.tables import TableServiceClient
            from azure.identity import DefaultAzureCredential

            service = TableServiceClient(
                endpoint=self._account_url,
                credential=DefaultAzureCredential(),
            )
            try:
                service.create_table(table_name)
            except ResourceExistsError:
                pass
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "master_plan_store: create_table(%s) failed (assuming exists): %s",
                    table_name, exc,
                )
            new_client = service.get_table_client(table_name)
            setattr(self, attr, new_client)
            return new_client

    def _plans_client_get(self):
        return self._get_client(self._plans_table_name, "_plans_client")

    def _versions_client_get(self):
        return self._get_client(self._versions_table_name, "_versions_client")

    # -- Plans ----------------------------------------------------------------

    def save_plan(self, plan: MasterPlan) -> None:
        from azure.data.tables import UpdateMode

        record = {
            "PartitionKey": plan.user_id,
            "RowKey": plan.plan_id,
            "kind": "plan",
            "status": plan.status.value,
            "version": plan.version,
            "start_date": plan.start_date,
            "end_date": plan.end_date,
            "total_weeks": plan.total_weeks,
            "plan_json": plan.model_dump_json(),
            "created_at": plan.created_at,
            "updated_at": plan.updated_at,
        }
        self._plans_client_get().upsert_entity(record, mode=UpdateMode.REPLACE)

    def get_plan(self, user_id: str, plan_id: str) -> MasterPlan | None:
        from azure.core.exceptions import ResourceNotFoundError

        try:
            entity = self._plans_client_get().get_entity(
                partition_key=user_id, row_key=plan_id
            )
        except ResourceNotFoundError:
            return None
        return MasterPlan.model_validate_json(entity["plan_json"])

    def get_active_plan(self, user_id: str) -> MasterPlan | None:
        entities = list(self._plans_client_get().query_entities(
            "PartitionKey eq @pk and kind eq @kind and status eq @status",
            parameters={
                "pk": user_id,
                "kind": "plan",
                "status": MasterPlanStatus.ACTIVE.value,
            },
        ))
        if not entities:
            return None
        return MasterPlan.model_validate_json(entities[0]["plan_json"])

    def list_plans(self, user_id: str) -> list[MasterPlan]:
        entities = list(self._plans_client_get().query_entities(
            "PartitionKey eq @pk and kind eq @kind",
            parameters={"pk": user_id, "kind": "plan"},
        ))
        return [MasterPlan.model_validate_json(e["plan_json"]) for e in entities]

    def archive_previous(self, user_id: str, new_plan_id: str) -> None:
        from azure.data.tables import UpdateMode

        entities = list(self._plans_client_get().query_entities(
            "PartitionKey eq @pk and kind eq @kind",
            parameters={"pk": user_id, "kind": "plan"},
        ))
        for entity in entities:
            if (
                entity["RowKey"] != new_plan_id
                and entity.get("status") != MasterPlanStatus.ARCHIVED.value
            ):
                plan = MasterPlan.model_validate_json(entity["plan_json"])
                archived = plan.model_copy(update={"status": MasterPlanStatus.ARCHIVED})
                record = {
                    "PartitionKey": user_id,
                    "RowKey": plan.plan_id,
                    "kind": "plan",
                    "status": MasterPlanStatus.ARCHIVED.value,
                    "version": plan.version,
                    "start_date": plan.start_date,
                    "end_date": plan.end_date,
                    "total_weeks": plan.total_weeks,
                    "plan_json": archived.model_dump_json(),
                    "created_at": plan.created_at,
                    "updated_at": plan.updated_at,
                }
                self._plans_client_get().upsert_entity(record, mode=UpdateMode.REPLACE)

    # -- Versions -------------------------------------------------------------

    def save_version(self, version: MasterPlanVersion) -> None:
        from azure.data.tables import UpdateMode

        record = {
            "PartitionKey": version.plan_id,
            "RowKey": version.version_id,
            "kind": "version",
            "version": version.version,
            "changed_at": version.changed_at,
            "change_reason": version.change_reason,
            "change_summary": version.change_summary,
            "snapshot_json": version.snapshot_json,
        }
        self._versions_client_get().upsert_entity(record, mode=UpdateMode.REPLACE)

    def list_versions(self, plan_id: str) -> list[MasterPlanVersion]:
        entities = list(self._versions_client_get().query_entities(
            "PartitionKey eq @pk",
            parameters={"pk": plan_id},
        ))
        versions = [
            MasterPlanVersion(
                version_id=e["RowKey"],
                plan_id=e["PartitionKey"],
                version=int(e["version"]),
                changed_at=e.get("changed_at", ""),
                change_reason=e.get("change_reason", ""),
                change_summary=e.get("change_summary", ""),
                snapshot_json=e.get("snapshot_json", ""),
            )
            for e in entities
        ]
        versions.sort(key=lambda v: v.version, reverse=True)
        return versions

    def get_version(self, plan_id: str, version_id: str) -> MasterPlanVersion | None:
        from azure.core.exceptions import ResourceNotFoundError

        try:
            entity = self._versions_client_get().get_entity(
                partition_key=plan_id, row_key=version_id
            )
        except ResourceNotFoundError:
            return None
        return MasterPlanVersion(
            version_id=entity["RowKey"],
            plan_id=entity["PartitionKey"],
            version=int(entity["version"]),
            changed_at=entity.get("changed_at", ""),
            change_reason=entity.get("change_reason", ""),
            change_summary=entity.get("change_summary", ""),
            snapshot_json=entity.get("snapshot_json", ""),
        )


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def store_from_config(config: MasterPlanStorageConfig) -> MasterPlanStore:
    account_url = config.table_account_url.strip()
    table_name = config.table_name.strip() or DEFAULT_TABLE_NAME
    if account_url:
        logger.info(
            "master_plan_store: using Azure Table backend table=%s", table_name
        )
        return AzureTableMasterPlanStore(account_url, table_name)
    logger.info(
        "master_plan_store: using JSON file backend plans=%s versions=%s",
        _plans_file(),
        _versions_file(),
    )
    return FileMasterPlanStore()


def _is_auth_config_error(exc: ConfigError) -> bool:
    return "auth.public_key" in str(exc)


def _master_plan_config_from_env() -> MasterPlanStorageConfig:
    config = ServerConfig.default(env=resolve_config_env()).storage.master_plan
    storage = env_source().get("storage", {})
    master_plan = storage.get("master_plan", {}) if isinstance(storage, dict) else {}
    if isinstance(master_plan, dict):
        return config.with_updates(**master_plan)
    return config


def _master_plan_config() -> MasterPlanStorageConfig:
    try:
        return load_server_config().storage.master_plan
    except ConfigError as exc:
        if not _is_auth_config_error(exc):
            raise
        return _master_plan_config_from_env()


@lru_cache(maxsize=1)
def get_master_plan_store() -> MasterPlanStore:
    """Return the configured backend, cached as a singleton per process.

    Call ``reset_master_plan_store_cache()`` in tests to get a fresh instance.
    """
    return store_from_config(_master_plan_config())


def reset_master_plan_store_cache() -> None:
    """Test helper — drop the cached store so env changes take effect."""
    get_master_plan_store.cache_clear()
    clear_server_config_cache()
