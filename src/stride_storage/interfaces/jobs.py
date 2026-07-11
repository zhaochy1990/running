"""Tier A — domain-neutral async job model + store/queue protocols.

Pure interfaces: no ``sqlite3`` / ``azure`` import. Safe for any consumer.

This is the generic job abstraction that the async-job infra (state layer +
queue layer + worker) is built on. ``job_type`` is an open string so any
domain (onboarding pipeline, AI summaries, periodic tasks, coach generation)
can register its own types without widening a central enum. Concrete storage
lives in ``stride_storage.jobs`` (Tier B/C); the Azure queue backend lives in
``stride_storage.azure.queue_backend`` (Tier C).
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import Enum
from typing import Any, Protocol, runtime_checkable

from stride_storage.interfaces.config import QueueStorageConfig  # noqa: F401  (re-export)


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


@dataclass(frozen=True)
class JobRecord:
    """A single async job's state row (PartitionKey=user_id, RowKey=job_id).

    Domain-neutral: ``job_type`` is an open string keyed to a handler in the
    worker's registry. ``input_json`` / ``result_json`` carry the per-type
    payload so this row never needs type-specific columns.
    """

    job_id: str
    user_id: str
    job_type: str
    status: JobStatus
    progress_pct: int = 0
    stage: str | None = None
    attempts: int = 0
    heartbeat_at: str = ""
    input_json: str | None = None
    result_json: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    created_at: str = ""
    updated_at: str = ""
    completed_at: str | None = None

    def with_updates(self, **updates: Any) -> JobRecord:
        return replace(self, **updates)


@runtime_checkable
class JobStore(Protocol):
    """State layer: the durable record of every job's lifecycle.

    Kept intentionally narrow. ``create`` writes the QUEUED row before the
    message is enqueued; ``update`` mutates named fields atomically per row.
    """

    def create(self, job: JobRecord) -> JobRecord: ...
    def update(self, job_id: str, user_id: str, **fields: Any) -> JobRecord: ...
    def get(self, user_id: str, job_id: str) -> JobRecord | None: ...
    def list_running(self) -> list[JobRecord]: ...
    def list_by_user(self, user_id: str, *, limit: int | None = None) -> list[JobRecord]: ...
    def delete_user(self, user_id: str) -> int: ...


@dataclass(frozen=True)
class QueueMessage:
    """A dequeued message: the job coordinates + queue bookkeeping.

    ``receipt`` is the backend-specific handle needed to delete/extend the
    message; ``dequeue_count`` drives poison detection (retry ceiling).
    """

    job_id: str
    user_id: str
    receipt: Any
    dequeue_count: int = 1


@runtime_checkable
class JobQueue(Protocol):
    """Queue layer: at-least-once delivery with visibility-timeout retries.

    ``enqueue`` publishes a job pointer. ``receive`` leases up to ``max`` messages
    (hidden for ``visibility_timeout_s``); an un-``delete``d message reappears
    after the timeout (automatic retry). ``delete`` acks a done message.
    """

    def enqueue(self, *, job_id: str, user_id: str, delay_s: int = 0) -> None: ...
    def receive(
        self, *, max: int = 1, visibility_timeout_s: int = 300
    ) -> list[QueueMessage]: ...
    def delete(self, message: QueueMessage) -> None: ...
