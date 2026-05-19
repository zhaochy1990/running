"""WeeklyVersionStore — see plan §4.1.

Stores ``strideweeklyversions`` rows:
    PartitionKey = "{user_id}|{folder}"
    RowKey       = "{reverse_time_key}|{version_id}"

This gives us free reverse-chronological listing per (user, folder) via Table
key order — exactly the pattern :func:`make_reverse_time_key` produces.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel
from stride_server.config.models import CoachPersistenceConfig

from .store import path_safe


def make_reverse_time_key(*, ms_since_epoch: int | None = None) -> str:
    """Plan §4.4: zero-padded ``(2**63 - 1) - ms``. Lexical asc == temporal desc."""
    ms = ms_since_epoch if ms_since_epoch is not None else int(time.time() * 1000)
    return f"{(2**63 - 1) - ms:020d}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _q(s: str) -> str:
    return s.replace("'", "''")




class WeeklyPlanVersion(BaseModel):
    user_id: str
    folder: str
    version_id: str
    parent_version_id: str | None
    artifact_json: str  # serialised WeeklyPlan dict
    rationale: str
    applied_op_ids: list[str]
    proposal_id: str | None
    created_by: str
    created_at: str


def _version_to_entity(v: WeeklyPlanVersion, reverse_key: str) -> dict[str, Any]:
    return {
        "PartitionKey": f"{v.user_id}|{v.folder}",
        "RowKey": f"{reverse_key}|{v.version_id}",
        "user_id": v.user_id,
        "folder": v.folder,
        "version_id": v.version_id,
        "parent_version_id": v.parent_version_id,
        "artifact_json": v.artifact_json,
        "rationale": v.rationale,
        "applied_op_ids_json": json.dumps(v.applied_op_ids, ensure_ascii=False, sort_keys=True),
        "proposal_id": v.proposal_id,
        "created_by": v.created_by,
        "created_at": v.created_at,
    }


def _entity_to_version(entity: dict[str, Any]) -> WeeklyPlanVersion:
    return WeeklyPlanVersion(
        user_id=entity["user_id"],
        folder=entity["folder"],
        version_id=entity["version_id"],
        parent_version_id=entity.get("parent_version_id"),
        artifact_json=entity["artifact_json"],
        rationale=entity.get("rationale", ""),
        applied_op_ids=json.loads(entity.get("applied_op_ids_json", "[]")),
        proposal_id=entity.get("proposal_id"),
        created_by=entity.get("created_by", "unknown"),
        created_at=entity["created_at"],
    )


@runtime_checkable
class WeeklyVersionStore(Protocol):
    def add_version(self, version: WeeklyPlanVersion) -> str: ...
    def get_version(
        self, user_id: str, folder: str, version_id: str
    ) -> WeeklyPlanVersion | None: ...
    def list_versions(
        self, user_id: str, folder: str, *, limit: int | None = None
    ) -> list[WeeklyPlanVersion]: ...
    def delete_user(self, user_id: str) -> int: ...


# ---------------------------------------------------------------------------
# File backend
# ---------------------------------------------------------------------------


class FileWeeklyVersionStore(WeeklyVersionStore):
    def __init__(self, base_dir: str | Path) -> None:
        self._base = Path(base_dir)
        self._base.mkdir(parents=True, exist_ok=True)

    def _partition_dir(self, user_id: str, folder: str) -> Path:
        return self._base / path_safe(f"{user_id}|{folder}")

    def add_version(self, version: WeeklyPlanVersion) -> str:
        reverse_key = make_reverse_time_key()
        d = self._partition_dir(version.user_id, version.folder)
        d.mkdir(parents=True, exist_ok=True)
        entity = _version_to_entity(version, reverse_key)
        # The reverse-time prefix on the filename gives us reverse-chronological
        # listing from a plain sorted dir scan.
        (d / f"{reverse_key}__{version.version_id}.json").write_text(
            json.dumps(entity, ensure_ascii=False, sort_keys=True)
        )
        return entity["RowKey"]

    def get_version(
        self, user_id: str, folder: str, version_id: str
    ) -> WeeklyPlanVersion | None:
        d = self._partition_dir(user_id, folder)
        if not d.exists():
            return None
        for f in d.glob(f"*__{version_id}.json"):
            return _entity_to_version(json.loads(f.read_text()))
        return None

    def list_versions(
        self, user_id: str, folder: str, *, limit: int | None = None
    ) -> list[WeeklyPlanVersion]:
        d = self._partition_dir(user_id, folder)
        if not d.exists():
            return []
        files = sorted(d.glob("*.json"))  # reverse-time prefix → newest first
        out = [_entity_to_version(json.loads(f.read_text())) for f in files]
        return out[:limit] if limit else out

    def delete_user(self, user_id: str) -> int:
        # Partition dir name is ``path_safe(f"{user_id}|{folder}")``; ``|`` is
        # escaped to ``___`` by ``_safe`` so the user-scope prefix is
        # ``path_safe(f"{user_id}|")`` exactly — keep this aligned.
        prefix = path_safe(f"{user_id}|")
        count = 0
        for d in self._base.iterdir():
            if not d.is_dir() or not d.name.startswith(prefix):
                continue
            for f in d.glob("*.json"):
                f.unlink()
                count += 1
            try:
                d.rmdir()
            except OSError:
                pass
        return count


# ---------------------------------------------------------------------------
# Azure backend
# ---------------------------------------------------------------------------


class AzureWeeklyVersionStore(WeeklyVersionStore):
    def __init__(
        self,
        *,
        table_account_url: str,
        table_name: str,
        credential: Any | None = None,
    ) -> None:
        from azure.data.tables import TableServiceClient

        if credential is None:
            from azure.identity import DefaultAzureCredential

            credential = DefaultAzureCredential()
        self._client = TableServiceClient(
            endpoint=table_account_url, credential=credential
        ).create_table_if_not_exists(table_name)

    @classmethod
    def from_env(cls) -> AzureWeeklyVersionStore:
        from stride_server.config import load_server_config

        config = load_server_config().coach_persistence
        return cls(
            table_account_url=config.table_account_url,
            table_name=config.weekly_versions_table_name,
        )

    def add_version(self, version: WeeklyPlanVersion) -> str:
        reverse_key = make_reverse_time_key()
        entity = _version_to_entity(version, reverse_key)
        self._client.create_entity(entity)
        return entity["RowKey"]

    def get_version(
        self, user_id: str, folder: str, version_id: str
    ) -> WeeklyPlanVersion | None:
        partition = f"{user_id}|{folder}"
        rows = list(
            self._client.query_entities(
                f"PartitionKey eq '{_q(partition)}' and version_id eq '{_q(version_id)}'"
            )
        )
        if not rows:
            return None
        return _entity_to_version(dict(rows[0]))

    def list_versions(
        self, user_id: str, folder: str, *, limit: int | None = None
    ) -> list[WeeklyPlanVersion]:
        partition = f"{user_id}|{folder}"
        rows = list(self._client.query_entities(f"PartitionKey eq '{_q(partition)}'"))
        # Azure returns by RowKey asc; reverse-time keys are ascending = newest first
        rows.sort(key=lambda r: r["RowKey"])
        out = [_entity_to_version(dict(r)) for r in rows]
        return out[:limit] if limit else out

    def delete_user(self, user_id: str) -> int:
        # Plan §11.4 sweep — PartitionKey starts_with `{user_id}|`.
        # Upper bound is ``}`` (0x7D), the byte immediately after ``|``
        # (0x7C). Earlier versions used ``;`` (0x3B) which is LESS than
        # ``|`` and silently returns zero rows — a real data-deletion
        # silent failure. Tested via the file backend (which uses
        # startswith and didn't surface this); the Azure path now matches.
        rows = list(
            self._client.query_entities(
                f"PartitionKey ge '{_q(user_id)}|' and PartitionKey lt '{_q(user_id)}}}'"
            )
        )
        for r in rows:
            self._client.delete_entity(r["PartitionKey"], r["RowKey"])
        return len(rows)


# ---------------------------------------------------------------------------
# factory
# ---------------------------------------------------------------------------


def weekly_version_store_from_env() -> WeeklyVersionStore:
    from stride_server.config import load_server_config

    return weekly_version_store_from_config(load_server_config().coach_persistence)


def weekly_version_store_from_config(config: CoachPersistenceConfig) -> WeeklyVersionStore:
    if config.table_account_url:
        return AzureWeeklyVersionStore(
            table_account_url=config.table_account_url,
            table_name=config.weekly_versions_table_name,
        )
    return FileWeeklyVersionStore(Path(config.file_backend_dir) / "weekly_versions")
