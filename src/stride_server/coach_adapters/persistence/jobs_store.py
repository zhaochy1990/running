"""JobsStore — see plan §4.1, §8.

Backs the ``stridecoachjobs`` Azure Table. Pattern A (plan §8) requires the
job runner to be able to write the row BEFORE the background task fires, so
the public surface is intentionally narrow: create / update / get /
list_running / list_by_user / delete.

Dual-backend mirrors :class:`FileCheckpointStore` — JSON files for dev,
Azure Table for prod, byte-equivalent semantics.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from coach.schemas import CoachJob, JobStage, JobStatus, JobType

from .store import path_safe


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _q(s: str) -> str:
    return s.replace("'", "''")


def _job_to_entity(job: CoachJob) -> dict[str, Any]:
    return {
        "PartitionKey": job.user_id,
        "RowKey": job.job_id,
        "job_type": job.job_type.value,
        "status": job.status.value,
        "stage": job.stage.value if job.stage else None,
        "progress_pct": job.progress_pct,
        "heartbeat_at": job.heartbeat_at,
        "input_json": job.input_json,
        "result_json": job.result_json,
        "review_report_json": job.review_report_json,
        "error_code": job.error_code,
        "error_message": job.error_message,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "completed_at": job.completed_at,
    }


def _entity_to_job(entity: dict[str, Any]) -> CoachJob:
    return CoachJob(
        job_id=entity["RowKey"],
        user_id=entity["PartitionKey"],
        job_type=JobType(entity["job_type"]),
        status=JobStatus(entity["status"]),
        stage=JobStage(entity["stage"]) if entity.get("stage") else None,
        progress_pct=int(entity.get("progress_pct") or 0),
        heartbeat_at=entity["heartbeat_at"],
        input_json=entity.get("input_json"),
        result_json=entity.get("result_json"),
        review_report_json=entity.get("review_report_json"),
        error_code=entity.get("error_code"),
        error_message=entity.get("error_message"),
        created_at=entity["created_at"],
        updated_at=entity["updated_at"],
        completed_at=entity.get("completed_at"),
    )


@runtime_checkable
class JobsStore(Protocol):
    def create(self, job: CoachJob) -> CoachJob: ...
    def update(self, job_id: str, user_id: str, **fields: Any) -> CoachJob: ...
    def get(self, user_id: str, job_id: str) -> CoachJob | None: ...
    def list_running(self) -> list[CoachJob]: ...
    def list_by_user(self, user_id: str, *, limit: int | None = None) -> list[CoachJob]: ...
    def delete_user(self, user_id: str) -> int: ...


# ---------------------------------------------------------------------------
# File backend
# ---------------------------------------------------------------------------


class FileJobsStore(JobsStore):
    def __init__(self, base_dir: str | Path) -> None:
        self._base = Path(base_dir)
        self._base.mkdir(parents=True, exist_ok=True)

    def _path(self, user_id: str, job_id: str) -> Path:
        return self._base / path_safe(user_id) / f"{job_id}.json"

    def create(self, job: CoachJob) -> CoachJob:
        p = self._path(job.user_id, job.job_id)
        if p.exists():
            raise ValueError(f"job {job.job_id} already exists for user {job.user_id}")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(
            json.dumps(_job_to_entity(job), ensure_ascii=False, sort_keys=True, default=str)
        )
        return job

    def update(self, job_id: str, user_id: str, **fields: Any) -> CoachJob:
        p = self._path(user_id, job_id)
        if not p.exists():
            raise KeyError(f"no job {job_id} for user {user_id}")
        entity = json.loads(p.read_text())
        for k, v in fields.items():
            if k in ("job_type",) and isinstance(v, JobType):
                v = v.value
            elif k == "status" and isinstance(v, JobStatus):
                v = v.value
            elif k == "stage" and isinstance(v, JobStage):
                v = v.value
            entity[k] = v
        entity["updated_at"] = _now_iso()
        p.write_text(json.dumps(entity, ensure_ascii=False, sort_keys=True, default=str))
        return _entity_to_job(entity)

    def get(self, user_id: str, job_id: str) -> CoachJob | None:
        p = self._path(user_id, job_id)
        if not p.exists():
            return None
        return _entity_to_job(json.loads(p.read_text()))

    def list_running(self) -> list[CoachJob]:
        out: list[CoachJob] = []
        for user_dir in self._base.iterdir():
            if not user_dir.is_dir():
                continue
            for f in user_dir.glob("*.json"):
                entity = json.loads(f.read_text())
                if entity.get("status") == JobStatus.RUNNING.value:
                    out.append(_entity_to_job(entity))
        return out

    def list_by_user(self, user_id: str, *, limit: int | None = None) -> list[CoachJob]:
        user_dir = self._base / path_safe(user_id)
        if not user_dir.exists():
            return []
        out: list[CoachJob] = []
        for f in sorted(user_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            out.append(_entity_to_job(json.loads(f.read_text())))
            if limit is not None and len(out) >= limit:
                break
        return out

    def delete_user(self, user_id: str) -> int:
        user_dir = self._base / path_safe(user_id)
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


# ---------------------------------------------------------------------------
# Azure backend
# ---------------------------------------------------------------------------


class AzureJobsStore(JobsStore):
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
    def from_env(cls) -> AzureJobsStore:
        return cls(
            table_account_url=os.environ["STRIDE_COACH_TABLE_ACCOUNT_URL"],
            table_name=os.environ.get("STRIDE_COACH_JOBS_TABLE_NAME", "stridecoachjobs"),
        )

    def create(self, job: CoachJob) -> CoachJob:
        self._client.create_entity(_job_to_entity(job))
        return job

    def update(self, job_id: str, user_id: str, **fields: Any) -> CoachJob:
        from azure.core.exceptions import ResourceNotFoundError

        try:
            entity = self._client.get_entity(user_id, job_id)
        except ResourceNotFoundError as exc:
            raise KeyError(f"no job {job_id} for user {user_id}") from exc
        e = dict(entity)
        for k, v in fields.items():
            if k == "job_type" and isinstance(v, JobType):
                v = v.value
            elif k == "status" and isinstance(v, JobStatus):
                v = v.value
            elif k == "stage" and isinstance(v, JobStage):
                v = v.value
            e[k] = v
        e["updated_at"] = _now_iso()
        self._client.upsert_entity(e)
        return _entity_to_job(e)

    def get(self, user_id: str, job_id: str) -> CoachJob | None:
        from azure.core.exceptions import ResourceNotFoundError

        try:
            entity = self._client.get_entity(user_id, job_id)
        except ResourceNotFoundError:
            return None
        return _entity_to_job(dict(entity))

    def list_running(self) -> list[CoachJob]:
        running_value = JobStatus.RUNNING.value
        rows = self._client.query_entities(f"status eq '{_q(running_value)}'")
        return [_entity_to_job(dict(r)) for r in rows]

    def list_by_user(self, user_id: str, *, limit: int | None = None) -> list[CoachJob]:
        rows = list(self._client.query_entities(f"PartitionKey eq '{_q(user_id)}'"))
        rows.sort(key=lambda r: r.get("updated_at", ""), reverse=True)
        if limit is not None:
            rows = rows[:limit]
        return [_entity_to_job(dict(r)) for r in rows]

    def delete_user(self, user_id: str) -> int:
        rows = list(self._client.query_entities(f"PartitionKey eq '{_q(user_id)}'"))
        for r in rows:
            self._client.delete_entity(user_id, r["RowKey"])
        return len(rows)


# ---------------------------------------------------------------------------
# factory
# ---------------------------------------------------------------------------


def jobs_store_from_env() -> JobsStore:
    if os.environ.get("STRIDE_COACH_TABLE_ACCOUNT_URL"):
        return AzureJobsStore.from_env()
    base = os.environ.get(
        "STRIDE_COACH_FILE_BACKEND_DIR",
        os.path.join("data", "_coach_dev", "jobs"),
    )
    return FileJobsStore(base)


