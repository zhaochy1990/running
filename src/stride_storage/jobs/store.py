"""Generic JobStore backends — dev (JSON files) + prod (Azure Table).

State layer for the async-job infra. Domain-neutral: stores ``JobRecord`` rows
keyed (user_id, job_id). Mirrors the dual-backend shape of
``coach_persistence.jobs_store`` but with no coach coupling. Azure imports are
lazy per the Tier-C azure-free invariant.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from stride_storage.interfaces.jobs import (
    JobRecord,
    JobStatus,
    JobStore,
    QueueStorageConfig,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _q(s: str) -> str:
    return s.replace("'", "''")


def _path_safe(component: str) -> str:
    # Keep filesystem keys flat and safe (user ids are UUIDs, but be defensive).
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in component)


_FIELDS = (
    "job_type",
    "status",
    "progress_pct",
    "stage",
    "attempts",
    "heartbeat_at",
    "input_json",
    "result_json",
    "error_code",
    "error_message",
    "created_at",
    "updated_at",
    "completed_at",
)


def _to_entity(job: JobRecord) -> dict[str, Any]:
    return {
        "PartitionKey": job.user_id,
        "RowKey": job.job_id,
        "job_type": job.job_type,
        "status": job.status.value,
        "progress_pct": job.progress_pct,
        "stage": job.stage,
        "attempts": job.attempts,
        "heartbeat_at": job.heartbeat_at,
        "input_json": job.input_json,
        "result_json": job.result_json,
        "error_code": job.error_code,
        "error_message": job.error_message,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "completed_at": job.completed_at,
    }


def _from_entity(entity: dict[str, Any]) -> JobRecord:
    return JobRecord(
        job_id=entity["RowKey"],
        user_id=entity["PartitionKey"],
        job_type=entity["job_type"],
        status=JobStatus(entity["status"]),
        progress_pct=int(entity.get("progress_pct") or 0),
        stage=entity.get("stage"),
        attempts=int(entity.get("attempts") or 0),
        heartbeat_at=entity.get("heartbeat_at") or "",
        input_json=entity.get("input_json"),
        result_json=entity.get("result_json"),
        error_code=entity.get("error_code"),
        error_message=entity.get("error_message"),
        created_at=entity.get("created_at") or "",
        updated_at=entity.get("updated_at") or "",
        completed_at=entity.get("completed_at"),
    )


def _coerce_field(key: str, value: Any) -> Any:
    if key == "status" and isinstance(value, JobStatus):
        return value.value
    return value


class FileJobStore(JobStore):
    """Dev backend — one JSON file per job under ``<base>/<user>/<job>.json``."""

    def __init__(self, base_dir: str | Path) -> None:
        self._base = Path(base_dir)
        self._base.mkdir(parents=True, exist_ok=True)

    def _path(self, user_id: str, job_id: str) -> Path:
        return self._base / _path_safe(user_id) / f"{_path_safe(job_id)}.json"

    def create(self, job: JobRecord) -> JobRecord:
        p = self._path(job.user_id, job.job_id)
        if p.exists():
            raise ValueError(f"job {job.job_id} already exists for user {job.user_id}")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(
            json.dumps(_to_entity(job), ensure_ascii=False, sort_keys=True, default=str)
        )
        return job

    def update(self, job_id: str, user_id: str, **fields: Any) -> JobRecord:
        p = self._path(user_id, job_id)
        if not p.exists():
            raise KeyError(f"no job {job_id} for user {user_id}")
        entity = json.loads(p.read_text())
        for k, v in fields.items():
            if k not in _FIELDS:
                raise AttributeError(f"unknown job field: {k}")
            entity[k] = _coerce_field(k, v)
        entity["updated_at"] = _now_iso()
        p.write_text(json.dumps(entity, ensure_ascii=False, sort_keys=True, default=str))
        return _from_entity(entity)

    def get(self, user_id: str, job_id: str) -> JobRecord | None:
        p = self._path(user_id, job_id)
        if not p.exists():
            return None
        return _from_entity(json.loads(p.read_text()))

    def list_running(self) -> list[JobRecord]:
        out: list[JobRecord] = []
        for user_dir in self._base.iterdir():
            if not user_dir.is_dir():
                continue
            for f in user_dir.glob("*.json"):
                entity = json.loads(f.read_text())
                if entity.get("status") == JobStatus.RUNNING.value:
                    out.append(_from_entity(entity))
        return out

    def list_by_user(self, user_id: str, *, limit: int | None = None) -> list[JobRecord]:
        user_dir = self._base / _path_safe(user_id)
        if not user_dir.exists():
            return []
        out: list[JobRecord] = []
        for f in sorted(user_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            out.append(_from_entity(json.loads(f.read_text())))
            if limit is not None and len(out) >= limit:
                break
        return out

    def delete_user(self, user_id: str) -> int:
        user_dir = self._base / _path_safe(user_id)
        if not user_dir.exists():
            return 0
        count = 0
        for f in user_dir.glob("*.json"):
            f.unlink()
            count += 1
        try:
            user_dir.rmdir()
        except OSError:
            pass
        return count


class AzureTableJobStore(JobStore):
    """Prod backend — Azure Table, one entity per job. Azure imports are lazy."""

    def __init__(
        self,
        *,
        table_account_url: str,
        table_name: str,
        credential: Any | None = None,
    ) -> None:
        from azure.data.tables import TableServiceClient

        if credential is None:
            from stride_storage.azure.credentials import get_credential

            credential = get_credential()
        self._client = TableServiceClient(
            endpoint=table_account_url, credential=credential
        ).create_table_if_not_exists(table_name)

    def create(self, job: JobRecord) -> JobRecord:
        self._client.create_entity(_to_entity(job))
        return job

    def update(self, job_id: str, user_id: str, **fields: Any) -> JobRecord:
        from azure.core.exceptions import ResourceNotFoundError

        try:
            entity = self._client.get_entity(user_id, job_id)
        except ResourceNotFoundError as exc:
            raise KeyError(f"no job {job_id} for user {user_id}") from exc
        e = dict(entity)
        for k, v in fields.items():
            if k not in _FIELDS:
                raise AttributeError(f"unknown job field: {k}")
            e[k] = _coerce_field(k, v)
        e["updated_at"] = _now_iso()
        self._client.upsert_entity(e)
        return _from_entity(e)

    def get(self, user_id: str, job_id: str) -> JobRecord | None:
        from azure.core.exceptions import ResourceNotFoundError

        try:
            entity = self._client.get_entity(user_id, job_id)
        except ResourceNotFoundError:
            return None
        return _from_entity(dict(entity))

    def list_running(self) -> list[JobRecord]:
        rows = self._client.query_entities(f"status eq '{_q(JobStatus.RUNNING.value)}'")
        return [_from_entity(dict(r)) for r in rows]

    def list_by_user(self, user_id: str, *, limit: int | None = None) -> list[JobRecord]:
        rows = list(self._client.query_entities(f"PartitionKey eq '{_q(user_id)}'"))
        rows.sort(key=lambda r: r.get("updated_at", ""), reverse=True)
        if limit is not None:
            rows = rows[:limit]
        return [_from_entity(dict(r)) for r in rows]

    def delete_user(self, user_id: str) -> int:
        rows = list(self._client.query_entities(f"PartitionKey eq '{_q(user_id)}'"))
        for r in rows:
            self._client.delete_entity(user_id, r["RowKey"])
        return len(rows)


def job_store_from_config(config: QueueStorageConfig) -> JobStore:
    """Pick Azure Table (prod) when a table account URL is set, else dev files."""
    if config.table_account_url:
        return AzureTableJobStore(
            table_account_url=config.table_account_url,
            table_name=config.jobs_table_name,
        )
    return FileJobStore(Path(config.file_backend_dir) / "state")
