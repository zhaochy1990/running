"""MasterPlan storage backends (Azure Table + JSON file) + factory.

Two tables in prod (``stridemasterplan`` plans, ``stridemasterplanversions``
versions); two JSON files in dev/test. Mirrors the likes pattern. Config
*loading* stays in ``stride_server``; this module takes a resolved
:class:`MasterPlanStorageConfig`.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path

from stride_core import db as core_db
from stride_core.master_plan import MasterPlan, MasterPlanStatus, MasterPlanVersion
from stride_storage.azure.backend_select import choose_backend
from stride_storage.azure.table_backend import AzureTableConnection
from stride_storage.interfaces.config import MasterPlanStorageConfig
from stride_storage.interfaces.master_plan import MasterPlanStore

logger = logging.getLogger(__name__)

DEFAULT_TABLE_NAME = "stridemasterplan"


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
    """JSON-file-backed store for tests and offline dev."""

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

    def list_active_plans(self) -> list[MasterPlan]:
        data = _read_json(_plans_file())
        return [
            MasterPlan.model_validate(raw)
            for user_bucket in data.values()
            if isinstance(user_bucket, dict)
            for raw in user_bucket.values()
            if isinstance(raw, dict)
            and raw.get("status") == MasterPlanStatus.ACTIVE.value
        ]

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

    Plans table  (``stridemasterplan``):  PartitionKey=user_id, RowKey=plan_id.
    Versions table (``stridemasterplanversions``): PartitionKey=plan_id,
    RowKey=version_id.
    """

    def __init__(self, account_url: str, table_name: str) -> None:
        self._plans = AzureTableConnection(account_url, table_name)
        self._versions = AzureTableConnection(account_url, table_name + "versions")

    # -- Plans ----------------------------------------------------------------

    def save_plan(self, plan: MasterPlan) -> None:
        from azure.data.tables import UpdateMode

        record = {
            "PartitionKey": plan.user_id,
            "RowKey": plan.plan_id,
            "kind": "plan",
            "status": plan.status.value,
            "version": plan.version,
            "plan_json": plan.model_dump_json(),
            "created_at": plan.created_at,
            "updated_at": plan.updated_at,
        }
        self._plans.table().upsert_entity(record, mode=UpdateMode.REPLACE)

    def get_plan(self, user_id: str, plan_id: str) -> MasterPlan | None:
        from azure.core.exceptions import ResourceNotFoundError

        try:
            entity = self._plans.table().get_entity(
                partition_key=user_id, row_key=plan_id
            )
        except ResourceNotFoundError:
            return None
        return MasterPlan.model_validate_json(entity["plan_json"])

    def get_active_plan(self, user_id: str) -> MasterPlan | None:
        entities = list(self._plans.table().query_entities(
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

    def list_active_plans(self) -> list[MasterPlan]:
        entities = list(self._plans.table().query_entities(
            "kind eq @kind and status eq @status",
            parameters={
                "kind": "plan",
                "status": MasterPlanStatus.ACTIVE.value,
            },
        ))
        return [MasterPlan.model_validate_json(e["plan_json"]) for e in entities]

    def list_plans(self, user_id: str) -> list[MasterPlan]:
        entities = list(self._plans.table().query_entities(
            "PartitionKey eq @pk and kind eq @kind",
            parameters={"pk": user_id, "kind": "plan"},
        ))
        return [MasterPlan.model_validate_json(e["plan_json"]) for e in entities]

    def archive_previous(self, user_id: str, new_plan_id: str) -> None:
        from azure.data.tables import UpdateMode

        entities = list(self._plans.table().query_entities(
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
                    "plan_json": archived.model_dump_json(),
                    "created_at": plan.created_at,
                    "updated_at": plan.updated_at,
                }
                self._plans.table().upsert_entity(record, mode=UpdateMode.REPLACE)

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
        self._versions.table().upsert_entity(record, mode=UpdateMode.REPLACE)

    def list_versions(self, plan_id: str) -> list[MasterPlanVersion]:
        entities = list(self._versions.table().query_entities(
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
            entity = self._versions.table().get_entity(
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

    def _azure() -> MasterPlanStore:
        logger.info(
            "master_plan_store: using Azure Table backend table=%s", table_name
        )
        return AzureTableMasterPlanStore(account_url, table_name)

    def _file() -> MasterPlanStore:
        logger.info(
            "master_plan_store: using JSON file backend plans=%s versions=%s",
            _plans_file(),
            _versions_file(),
        )
        return FileMasterPlanStore()

    return choose_backend(account_url, azure_factory=_azure, file_factory=_file)
