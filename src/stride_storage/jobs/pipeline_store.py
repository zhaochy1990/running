"""PipelineRun store backends — dev (JSON files) + prod (Azure Table).

State layer for pipeline runs, parallel to ``stride_storage.jobs.store`` (the
job state layer). Same dual-backend shape and lazy-azure invariant. A pipeline
run is the aggregate record a client polls for a multi-step pipeline's overall
progress.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from stride_storage.interfaces.jobs import (
    JobStatus,
    PipelineRunRecord,
    PipelineRunStore,
    QueueStorageConfig,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _q(s: str) -> str:
    return s.replace("'", "''")


def _path_safe(component: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in component)


_FIELDS = (
    "pipeline_name",
    "status",
    "current_step",
    "steps_json",
    "error_message",
    "created_at",
    "updated_at",
    "completed_at",
)


def _to_entity(run: PipelineRunRecord) -> dict[str, Any]:
    return {
        "PartitionKey": run.partition_key,
        "RowKey": run.run_id,
        "pipeline_name": run.pipeline_name,
        "status": run.status.value,
        "current_step": run.current_step,
        "steps_json": run.steps_json,
        "error_message": run.error_message,
        "created_at": run.created_at,
        "updated_at": run.updated_at,
        "completed_at": run.completed_at,
    }


def _from_entity(entity: dict[str, Any]) -> PipelineRunRecord:
    return PipelineRunRecord(
        run_id=entity["RowKey"],
        partition_key=entity["PartitionKey"],
        pipeline_name=entity["pipeline_name"],
        status=JobStatus(entity["status"]),
        current_step=entity.get("current_step"),
        steps_json=entity.get("steps_json"),
        error_message=entity.get("error_message"),
        created_at=entity.get("created_at") or "",
        updated_at=entity.get("updated_at") or "",
        completed_at=entity.get("completed_at"),
    )


def _coerce_field(key: str, value: Any) -> Any:
    if key == "status" and isinstance(value, JobStatus):
        return value.value
    return value


class FilePipelineRunStore(PipelineRunStore):
    """Dev backend — one JSON file per run under ``<base>/<partition>/<run>.json``."""

    def __init__(self, base_dir: str | Path) -> None:
        self._base = Path(base_dir)
        self._base.mkdir(parents=True, exist_ok=True)

    def _path(self, partition_key: str, run_id: str) -> Path:
        return self._base / _path_safe(partition_key) / f"{_path_safe(run_id)}.json"

    def create(self, run: PipelineRunRecord) -> PipelineRunRecord:
        p = self._path(run.partition_key, run.run_id)
        if p.exists():
            raise ValueError(
                f"pipeline run {run.run_id} already exists in partition {run.partition_key}"
            )
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(
            json.dumps(_to_entity(run), ensure_ascii=False, sort_keys=True, default=str)
        )
        return run

    def update(self, run_id: str, partition_key: str, **fields: Any) -> PipelineRunRecord:
        p = self._path(partition_key, run_id)
        if not p.exists():
            raise KeyError(f"no pipeline run {run_id} in partition {partition_key}")
        entity = json.loads(p.read_text())
        for k, v in fields.items():
            if k not in _FIELDS:
                raise AttributeError(f"unknown pipeline run field: {k}")
            entity[k] = _coerce_field(k, v)
        entity["updated_at"] = _now_iso()
        p.write_text(json.dumps(entity, ensure_ascii=False, sort_keys=True, default=str))
        return _from_entity(entity)

    def get(self, partition_key: str, run_id: str) -> PipelineRunRecord | None:
        p = self._path(partition_key, run_id)
        if not p.exists():
            return None
        return _from_entity(json.loads(p.read_text()))

    def list_by_partition(
        self, partition_key: str, *, limit: int | None = None
    ) -> list[PipelineRunRecord]:
        part_dir = self._base / _path_safe(partition_key)
        if not part_dir.exists():
            return []
        out: list[PipelineRunRecord] = []
        for f in sorted(part_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            out.append(_from_entity(json.loads(f.read_text())))
            if limit is not None and len(out) >= limit:
                break
        return out


class AzureTablePipelineRunStore(PipelineRunStore):
    """Prod backend — Azure Table, one entity per run. Azure imports are lazy."""

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

    def create(self, run: PipelineRunRecord) -> PipelineRunRecord:
        self._client.create_entity(_to_entity(run))
        return run

    def update(self, run_id: str, partition_key: str, **fields: Any) -> PipelineRunRecord:
        from azure.core.exceptions import ResourceNotFoundError

        try:
            entity = self._client.get_entity(partition_key, run_id)
        except ResourceNotFoundError as exc:
            raise KeyError(f"no pipeline run {run_id} in partition {partition_key}") from exc
        e = dict(entity)
        for k, v in fields.items():
            if k not in _FIELDS:
                raise AttributeError(f"unknown pipeline run field: {k}")
            e[k] = _coerce_field(k, v)
        e["updated_at"] = _now_iso()
        self._client.upsert_entity(e)
        return _from_entity(e)

    def get(self, partition_key: str, run_id: str) -> PipelineRunRecord | None:
        from azure.core.exceptions import ResourceNotFoundError

        try:
            entity = self._client.get_entity(partition_key, run_id)
        except ResourceNotFoundError:
            return None
        return _from_entity(dict(entity))

    def list_by_partition(
        self, partition_key: str, *, limit: int | None = None
    ) -> list[PipelineRunRecord]:
        rows = list(self._client.query_entities(f"PartitionKey eq '{_q(partition_key)}'"))
        rows.sort(key=lambda r: r.get("updated_at", ""), reverse=True)
        if limit is not None:
            rows = rows[:limit]
        return [_from_entity(dict(r)) for r in rows]


def pipeline_run_store_from_config(config: QueueStorageConfig) -> PipelineRunStore:
    """Azure Table (prod) when a table account URL is set, else dev files."""
    if config.table_account_url:
        return AzureTablePipelineRunStore(
            table_account_url=config.table_account_url,
            table_name=config.pipeline_runs_table_name,
        )
    return FilePipelineRunStore(Path(config.file_backend_dir) / "pipeline_runs")
