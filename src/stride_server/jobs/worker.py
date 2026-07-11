"""Async-job worker — dequeues jobs and dispatches to registered handlers.

Runs as a separate process (same image, different command; see
``stride_server.jobs.__main__``). The loop:

  1. receive up to N messages (leased for ``visibility_timeout_s``)
  2. safety net: dequeue_count over ceiling → dead-letter, mark FAILED
  3. no handler for job_type → terminal FAILED (retrying can't help)
  4. mark RUNNING + heartbeat, run handler(job, heartbeat=...)
  5. on success → DONE (+ result, error fields cleared), ack the message
  6. on handler error → record the error; if retries remain put the job BACK
     to QUEUED and leave the message so its lease expiry re-delivers it; on the
     final allowed attempt go terminal FAILED and dead-letter it

Status is honest about retries: a job mid-retry reads QUEUED (with the last
error stamped for diagnostics), not FAILED — so pollers waiting for a terminal
state (DONE/FAILED) don't see a transient failure as final. The message is
deleted (acked) only when the job reaches a terminal state or succeeds.

Crash safety is native to the queue: if the worker dies mid-handler, the lease
expires and the message reappears for another attempt (at-least-once). Handlers
must therefore be idempotent.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

from stride_storage.interfaces.jobs import (
    JobQueue,
    JobRecord,
    JobStatus,
    JobStore,
    QueueMessage,
    QueueStorageConfig,
)

from .registry import get_handler

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class JobWorker:
    def __init__(
        self,
        *,
        store: JobStore,
        queue: JobQueue,
        poison_queue: JobQueue,
        config: QueueStorageConfig,
    ) -> None:
        self._store = store
        self._queue = queue
        self._poison = poison_queue
        self._config = config

    def process_once(self, *, max_messages: int = 1) -> int:
        """Receive and process up to ``max_messages``. Returns the count handled."""
        msgs = self._queue.receive(
            max=max_messages, visibility_timeout_s=self._config.visibility_timeout_s
        )
        for msg in msgs:
            self._handle(msg)
        return len(msgs)

    def _handle(self, msg: QueueMessage) -> None:
        job = self._store.get(msg.partition_key, msg.job_id)
        if job is None:
            # Orphan message (state row gone) — drop it so it can't loop forever.
            logger.warning("job worker: no state row for %s/%s, dropping", msg.partition_key, msg.job_id)
            self._queue.delete(msg)
            return

        if msg.dequeue_count > self._config.poison_max_attempts:
            self._poison_job(job, msg)
            return

        handler = get_handler(job.job_type)
        if handler is None:
            # No handler is a permanent failure — retrying can't help. Terminal.
            logger.error("job worker: no handler for job_type=%s (job %s)", job.job_type, job.job_id)
            self._store.update(
                job.job_id, job.partition_key,
                status=JobStatus.FAILED,
                error_code="no_handler",
                error_message=f"no handler for {job.job_type}",
                completed_at=_now_iso(),
                heartbeat_at=_now_iso(),
            )
            self._queue.delete(msg)
            return

        self._store.update(
            job.job_id, job.partition_key,
            status=JobStatus.RUNNING,
            attempts=msg.dequeue_count,
            heartbeat_at=_now_iso(),
        )

        def heartbeat(*, stage: str | None = None, progress_pct: int | None = None) -> None:
            fields: dict[str, Any] = {"heartbeat_at": _now_iso()}
            if stage is not None:
                fields["stage"] = stage
            if progress_pct is not None:
                fields["progress_pct"] = max(0, min(100, int(progress_pct)))
            self._store.update(job.job_id, job.partition_key, **fields)

        try:
            result = handler(job, heartbeat=heartbeat)
        except Exception as exc:  # noqa: BLE001 — job boundary
            logger.exception("job %s (%s) failed", job.job_id, job.job_type)
            self._on_handler_error(job, msg, exc)
            return

        fields: dict[str, Any] = {
            "status": JobStatus.DONE,
            "progress_pct": 100,
            "completed_at": _now_iso(),
            "heartbeat_at": _now_iso(),
            # Clear any error recorded by a prior failed attempt — a retry that
            # now succeeds must not leave a stale error_code/message on a DONE job.
            "error_code": None,
            "error_message": None,
        }
        if result is not None:
            fields["result_json"] = json.dumps(result, ensure_ascii=False, default=str)
        self._store.update(job.job_id, job.partition_key, **fields)
        self._queue.delete(msg)

    def _on_handler_error(self, job: JobRecord, msg: QueueMessage, exc: Exception) -> None:
        """Record a handler failure. Non-terminal while retries remain.

        The message is left un-deleted so its lease expires and it is
        re-delivered. Until the poison ceiling is reached the job is put BACK to
        QUEUED (it is genuinely waiting for another attempt) with the latest
        error stamped for diagnostics — callers polling for a terminal state
        (DONE/FAILED) correctly see it as still in flight. The final allowed
        attempt flips it to terminal FAILED and dead-letters it, so a job that
        exhausts its retries does not sit forever as QUEUED with a live message.
        """
        code = type(exc).__name__
        message = str(exc)
        # ``msg.dequeue_count`` is this delivery's attempt number; the next
        # receive would be dequeue_count+1. If that would exceed the ceiling,
        # this attempt is the last — go terminal now instead of re-queuing.
        if msg.dequeue_count >= self._config.poison_max_attempts:
            logger.error(
                "job %s (%s) failed on final attempt %d — dead-lettering",
                job.job_id, job.job_type, msg.dequeue_count,
            )
            self._poison.enqueue(job_id=job.job_id, partition_key=job.partition_key)
            self._store.update(
                job.job_id, job.partition_key,
                status=JobStatus.FAILED,
                error_code=code,
                error_message=message,
                completed_at=_now_iso(),
                heartbeat_at=_now_iso(),
            )
            self._queue.delete(msg)
            return
        self._store.update(
            job.job_id, job.partition_key,
            status=JobStatus.QUEUED,
            error_code=code,
            error_message=message,
            heartbeat_at=_now_iso(),
        )

    def _poison_job(self, job: JobRecord, msg: QueueMessage) -> None:
        logger.error(
            "job %s (%s) exceeded %d attempts — poisoning",
            job.job_id, job.job_type, self._config.poison_max_attempts,
        )
        self._poison.enqueue(job_id=job.job_id, partition_key=job.partition_key)
        self._store.update(
            job.job_id, job.partition_key,
            status=JobStatus.FAILED,
            error_code="poison",
            error_message=f"exceeded {self._config.poison_max_attempts} attempts",
            completed_at=_now_iso(),
            heartbeat_at=_now_iso(),
        )
        self._queue.delete(msg)

    def run_forever(self, *, poll_interval_s: float = 2.0, max_messages: int = 4) -> None:
        logger.info("job worker started (queue=%s)", self._config.queue_name)
        while True:
            try:
                handled = self.process_once(max_messages=max_messages)
            except Exception:  # noqa: BLE001 — never let the loop die
                logger.exception("job worker loop error")
                handled = 0
            if handled == 0:
                time.sleep(poll_interval_s)
