"""JobClient — the enqueue facade tying the state store and the queue.

An enqueue is two steps, store-first (so a job is always inspectable even if
the queue publish races): write a QUEUED ``JobRecord``, then publish a pointer
message. This is the single entrypoint for both event triggers (a route
enqueues) and chaining (a handler enqueues the next job).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from stride_storage.interfaces.jobs import (
    GLOBAL_PARTITION,
    JobQueue,
    JobRecord,
    JobStatus,
    JobStore,
    QueueStorageConfig,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class JobClient:
    """Facade over a ``JobStore`` + ``JobQueue`` for enqueue + status reads."""

    def __init__(self, store: JobStore, queue: JobQueue) -> None:
        self._store = store
        self._queue = queue

    def enqueue(
        self,
        *,
        job_type: str,
        partition_key: str = GLOBAL_PARTITION,
        input_payload: dict[str, Any] | None = None,
        delay_s: int = 0,
    ) -> str:
        """Enqueue a job. ``partition_key`` is the owning scope — a user_id for
        user-scoped jobs, or ``GLOBAL_PARTITION`` (default) for global ones."""
        job_id = str(uuid4())
        now = _now_iso()
        record = JobRecord(
            job_id=job_id,
            partition_key=partition_key,
            job_type=job_type,
            status=JobStatus.QUEUED,
            heartbeat_at=now,
            input_json=(
                json.dumps(input_payload, ensure_ascii=False, default=str)
                if input_payload
                else None
            ),
            created_at=now,
            updated_at=now,
        )
        self._store.create(record)
        self._queue.enqueue(job_id=job_id, partition_key=partition_key, delay_s=delay_s)
        return job_id

    def get(self, partition_key: str, job_id: str) -> JobRecord | None:
        return self._store.get(partition_key, job_id)

    @property
    def store(self) -> JobStore:
        return self._store

    @property
    def queue(self) -> JobQueue:
        return self._queue


def enqueue_job(
    config: QueueStorageConfig,
    *,
    job_type: str,
    partition_key: str = GLOBAL_PARTITION,
    input_payload: dict[str, Any] | None = None,
    delay_s: int = 0,
) -> str:
    """One-shot enqueue for callers that don't hold a ``JobClient``.

    Builds the store + queue from a resolved config and enqueues. Server-side
    facades that enqueue frequently should hold a cached ``JobClient`` instead.
    """
    from stride_storage.jobs.queue import queue_from_config
    from stride_storage.jobs.store import job_store_from_config

    client = JobClient(job_store_from_config(config), queue_from_config(config))
    return client.enqueue(
        job_type=job_type,
        partition_key=partition_key,
        input_payload=input_payload,
        delay_s=delay_s,
    )
