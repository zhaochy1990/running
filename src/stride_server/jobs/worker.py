"""Async-job worker — dequeues jobs and dispatches to registered handlers.

Runs as a separate process (same image, different command; see
``stride_server.jobs.__main__``). The loop:

  1. receive up to N messages (leased for ``visibility_timeout_s``)
  2. poison check: dequeue_count > ceiling → move to poison queue, mark FAILED
  3. mark RUNNING + heartbeat, look up handler by job_type
  4. run handler(job, heartbeat=...) → DONE (+ result) or FAILED
  5. delete the message (ack) only after terminal state

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
        job = self._store.get(msg.user_id, msg.job_id)
        if job is None:
            # Orphan message (state row gone) — drop it so it can't loop forever.
            logger.warning("job worker: no state row for %s/%s, dropping", msg.user_id, msg.job_id)
            self._queue.delete(msg)
            return

        if msg.dequeue_count > self._config.poison_max_attempts:
            self._poison_job(job, msg)
            return

        handler = get_handler(job.job_type)
        if handler is None:
            logger.error("job worker: no handler for job_type=%s (job %s)", job.job_type, job.job_id)
            self._fail(job, code="no_handler", message=f"no handler for {job.job_type}")
            self._queue.delete(msg)
            return

        self._store.update(
            job.job_id, job.user_id,
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
            self._store.update(job.job_id, job.user_id, **fields)

        try:
            result = handler(job, heartbeat=heartbeat)
        except Exception as exc:  # noqa: BLE001 — job boundary
            logger.exception("job %s (%s) failed", job.job_id, job.job_type)
            # Leave the message un-deleted so the lease expires and it retries,
            # UNLESS the next attempt would exceed the poison ceiling — then the
            # subsequent receive will poison it. Record the failure meanwhile.
            self._fail(job, code=type(exc).__name__, message=str(exc))
            return

        fields: dict[str, Any] = {
            "status": JobStatus.DONE,
            "progress_pct": 100,
            "completed_at": _now_iso(),
            "heartbeat_at": _now_iso(),
        }
        if result is not None:
            fields["result_json"] = json.dumps(result, ensure_ascii=False, default=str)
        self._store.update(job.job_id, job.user_id, **fields)
        self._queue.delete(msg)

    def _fail(self, job: JobRecord, *, code: str, message: str) -> None:
        self._store.update(
            job.job_id, job.user_id,
            status=JobStatus.FAILED,
            error_code=code,
            error_message=message,
            heartbeat_at=_now_iso(),
        )

    def _poison_job(self, job: JobRecord, msg: QueueMessage) -> None:
        logger.error(
            "job %s (%s) exceeded %d attempts — poisoning",
            job.job_id, job.job_type, self._config.poison_max_attempts,
        )
        self._poison.enqueue(job_id=job.job_id, user_id=job.user_id)
        self._store.update(
            job.job_id, job.user_id,
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
