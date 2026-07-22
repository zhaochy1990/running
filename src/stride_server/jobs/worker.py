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
from typing import Any, Callable

from stride_storage.interfaces.jobs import (
    JobQueue,
    JobRecord,
    JobStatus,
    JobStore,
    QueueMessage,
    QueueStorageConfig,
)

from .cancellation import CancellationCheckUnavailable, JobCancelled
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
        on_completed: "Callable[[JobRecord], None] | None" = None,
        on_failed: "Callable[[JobRecord], None] | None" = None,
        is_cancelled: "Callable[[JobRecord], bool] | None" = None,
        on_cancelled: "Callable[[JobRecord], None] | None" = None,
    ) -> None:
        self._store = store
        self._queue = queue
        self._poison = poison_queue
        self._config = config
        # Optional lifecycle hooks (injected by build_worker to advance
        # pipelines). Kept optional so the worker stays generic — the job infra
        # itself has no pipeline dependency.
        self._on_completed = on_completed
        self._on_failed = on_failed
        # Cancellation seam (injected by build_worker with the account-deletion
        # fence + orchestrator cancel hook). Both default None so the generic
        # infra — and the existing test suite — behave exactly as before.
        # ``is_cancelled`` tells the worker a job's owner is being deleted;
        # ``on_cancelled`` cancels the owning pipeline run. Kept optional so the
        # worker itself has no coupling to the deletion coordinator.
        self._is_cancelled = is_cancelled
        self._on_cancelled = on_cancelled

    def _fire(self, hook: "Callable[[JobRecord], None] | None", job: JobRecord) -> bool:
        """Invoke a lifecycle hook. Returns True on success (or no hook).

        A hook failure must never raise into job handling, but the caller needs
        to know whether it succeeded: the completion hook advances the pipeline
        and is fired BEFORE the message is acked, so a False return tells the
        caller to leave the message for re-delivery instead of deleting it.
        """
        if hook is None:
            return True
        try:
            hook(job)
            return True
        except Exception:  # noqa: BLE001 — hook boundary
            logger.exception("job %s lifecycle hook failed", job.job_id)
            return False

    def _finalize_failed(self, failed: JobRecord, msg: QueueMessage) -> None:
        """Fire the failure hook, then ack — same ordering as the DONE path.

        The fail hook marks the pipeline run FAILED; if it can't (transient
        error / crash), leave the message so re-delivery retries the
        finalization rather than losing the FAILED signal. ``on_job_failed`` is
        idempotent, so a repeat is safe.
        """
        if not self._fire(self._on_failed, failed):
            logger.warning(
                "job %s: failure hook failed; leaving message for re-delivery",
                failed.job_id,
            )
            return
        self._queue.delete(msg)

    def _is_job_cancelled(self, job: JobRecord) -> bool:
        """Read the cancellation fence without ever failing open."""
        if self._is_cancelled is None:
            return False
        try:
            return bool(self._is_cancelled(job))
        except Exception as exc:  # noqa: BLE001 — predicate boundary
            logger.warning("job %s: cancel predicate failed", job.job_id, exc_info=True)
            raise CancellationCheckUnavailable from exc

    def _defer_for_cancellation_check(self, job: JobRecord) -> None:
        """Leave the message leased for retry without running the handler."""
        self._store.update(
            job.job_id,
            job.partition_key,
            status=JobStatus.QUEUED,
            heartbeat_at=_now_iso(),
        )

    def _finalize_cancelled(self, job: JobRecord, msg: QueueMessage) -> None:
        """Take a job to terminal CANCELLED: fire the cancel hook, then ack.

        Same ordering as the DONE/FAILED paths — advance the pipeline (mark the
        run CANCELLED) BEFORE acking, so a hook failure leaves the message for
        re-delivery instead of dropping the cancel signal. No poison, no retry.
        """
        cancelled = self._store.update(
            job.job_id, job.partition_key,
            status=JobStatus.CANCELLED,
            completed_at=_now_iso(),
            heartbeat_at=_now_iso(),
        )
        if not self._fire(self._on_cancelled, cancelled):
            logger.warning(
                "job %s: cancel hook failed; leaving message for re-delivery",
                job.job_id,
            )
            return
        self._queue.delete(msg)

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

        if job.status is JobStatus.CANCELLED:
            self._finalize_cancelled(job, msg)
            return
        if job.status is JobStatus.DONE:
            if self._fire(self._on_completed, job):
                self._queue.delete(msg)
            return
        if job.status is JobStatus.FAILED:
            self._finalize_failed(job, msg)
            return

        if msg.dequeue_count > self._config.poison_max_attempts:
            self._poison_job(job, msg)
            return

        handler = get_handler(job.job_type)
        if handler is None:
            # No handler is a permanent failure — retrying can't help. Terminal.
            logger.error("job worker: no handler for job_type=%s (job %s)", job.job_type, job.job_id)
            failed = self._store.update(
                job.job_id, job.partition_key,
                status=JobStatus.FAILED,
                error_code="no_handler",
                error_message=f"no handler for {job.job_type}",
                completed_at=_now_iso(),
                heartbeat_at=_now_iso(),
            )
            self._finalize_failed(failed, msg)
            return

        # Cancellation fence — check BEFORE marking RUNNING so a fenced job never
        # touches its handler (which would write the user's coros.db while the
        # API is deleting it). If the fence store is unavailable, leave the
        # message for retry rather than guessing that it is safe to write.
        try:
            if self._is_job_cancelled(job):
                self._finalize_cancelled(job, msg)
                return
        except CancellationCheckUnavailable:
            self._defer_for_cancellation_check(job)
            return

        self._store.update(
            job.job_id, job.partition_key,
            status=JobStatus.RUNNING,
            attempts=msg.dequeue_count,
            heartbeat_at=_now_iso(),
        )

        # Re-check after writing RUNNING to close the TOCTOU window: the fence
        # may have landed between the pre-check and this write, and a RUNNING job
        # is exactly what the API's wait loop blocks on.
        try:
            if self._is_job_cancelled(job):
                self._finalize_cancelled(job, msg)
                return
        except CancellationCheckUnavailable:
            self._defer_for_cancellation_check(job)
            return

        # Mutable holder for the in-flight message so heartbeat can renew the
        # lease and rotate the receipt (Azure returns a fresh pop_receipt on
        # extend); the final delete must use the latest receipt.
        current = {"msg": msg}

        def heartbeat(*, stage: str | None = None, progress_pct: int | None = None) -> None:
            # A fence that lands mid-handler surfaces here: every heartbeat
            # re-checks and raises JobCancelled so a long-running handler
            # (e.g. onboarding full_sync) aborts promptly instead of running to
            # completion against a directory the API is deleting.
            if self._is_job_cancelled(job):
                raise JobCancelled(f"job {job.job_id} cancelled mid-flight")
            fields: dict[str, Any] = {"heartbeat_at": _now_iso()}
            if stage is not None:
                fields["stage"] = stage
            if progress_pct is not None:
                fields["progress_pct"] = max(0, min(100, int(progress_pct)))
            self._store.update(job.job_id, job.partition_key, **fields)
            # Renew the queue lease so a long-running handler doesn't have its
            # message re-delivered mid-flight (duplicate run + stale-receipt
            # delete). Best-effort: a failed renewal must not break the handler.
            try:
                current["msg"] = self._queue.extend_visibility(
                    current["msg"], visibility_timeout_s=self._config.visibility_timeout_s
                )
            except Exception:  # noqa: BLE001
                logger.warning("job %s: visibility renewal failed", job.job_id, exc_info=True)

        try:
            result = handler(job, heartbeat=heartbeat)
        except CancellationCheckUnavailable:
            logger.warning(
                "job %s (%s) paused because cancellation state is unavailable",
                job.job_id,
                job.job_type,
            )
            self._defer_for_cancellation_check(job)
            return
        except JobCancelled:
            # Cooperative cancellation (fence landed mid-handler) — terminal, not
            # a failure: no retry, no poison, no failure notification.
            logger.info("job %s (%s) cancelled mid-flight", job.job_id, job.job_type)
            self._finalize_cancelled(job, current["msg"])
            return
        except Exception as exc:  # noqa: BLE001 — job boundary
            logger.exception("job %s (%s) failed", job.job_id, job.job_type)
            self._on_handler_error(job, current["msg"], exc)
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
        done = self._store.update(job.job_id, job.partition_key, **fields)
        # Advance the pipeline BEFORE acking the message. If the completion hook
        # fails (transient store/queue error) or the worker crashes here, the
        # message is NOT deleted → its lease expires → the job is re-delivered
        # and the (idempotent) handler + hook run again. Acking first would drop
        # the only signal that advances the pipeline, stranding the run. The
        # hook is idempotent (see orchestrator.on_job_completed), so re-delivery
        # is safe.
        if not self._fire(self._on_completed, done):
            logger.warning(
                "job %s: completion hook failed; leaving message for re-delivery",
                job.job_id,
            )
            return
        self._queue.delete(current["msg"])

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
            failed = self._store.update(
                job.job_id, job.partition_key,
                status=JobStatus.FAILED,
                error_code=code,
                error_message=message,
                completed_at=_now_iso(),
                heartbeat_at=_now_iso(),
            )
            self._finalize_failed(failed, msg)
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
        failed = self._store.update(
            job.job_id, job.partition_key,
            status=JobStatus.FAILED,
            error_code="poison",
            error_message=f"exceeded {self._config.poison_max_attempts} attempts",
            completed_at=_now_iso(),
            heartbeat_at=_now_iso(),
        )
        self._finalize_failed(failed, msg)

    def run_forever(self, *, poll_interval_s: float = 2.0, max_messages: int = 1) -> None:
        """Poll loop. Defaults to one message per receive so a long-running job
        (for example, a full onboarding watch sync) doesn't pre-lease a batch and
        let the other messages' visibility leases expire while it runs — that
        re-delivers them and duplicates work. One-at-a-time keeps every leased
        message actively heartbeated."""
        logger.info("job worker started (queue=%s)", self._config.queue_name)
        while True:
            try:
                handled = self.process_once(max_messages=max_messages)
            except Exception:  # noqa: BLE001 — never let the loop die
                logger.exception("job worker loop error")
                handled = 0
            if handled == 0:
                time.sleep(poll_interval_s)
