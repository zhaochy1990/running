"""Pattern A job scheduler — see plan §8.

The shape route handlers use::

    @router.post("/master-plan/generate")
    def generate(background_tasks: BackgroundTasks, ...):
        job_id = scheduler.create(user_id=u, job_type=JobType.MASTER_PLAN_GENERATE, input_payload={...})
        background_tasks.add_task(scheduler.run, job_id, work_fn)
        return {"job_id": job_id}

Where ``work_fn(job_id, *, heartbeat)`` is the actual job body (typically the
generation graph invocation). The scheduler:

1. writes a QUEUED row to ``stridecoachjobs`` BEFORE the background task fires
2. flips to RUNNING + initial heartbeat at the start of ``run``
3. exposes a ``heartbeat()`` closure the work_fn must call periodically
4. flips to DONE/FAILED on completion

Startup reconcile (in app.py lifespan hook) detects RUNNING jobs whose
heartbeat is older than ``STALE_HEARTBEAT_SECONDS`` and marks them FAILED.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from typing import Any, Callable
from uuid import uuid4

from coach.schemas import CoachJob, JobStage, JobStatus, JobType

logger = logging.getLogger(__name__)

# Heartbeat threshold for startup reconcile. ACA restarts typically take
# under a minute; a 2-minute window leaves headroom for slow LLM rounds
# that legitimately suppress heartbeats for ~60s.
STALE_HEARTBEAT_SECONDS = 120


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class JobScheduler:
    """Coordinates between BackgroundTasks and the JobsStore.

    The scheduler is thread-safe at the row level: the JobsStore's
    ``update`` is atomic per row, and the work_fn owns its job_id.
    Multiple workers in the same process are safe; multiple replicas
    require Service Bus (plan §8.4 follow-up).
    """

    def __init__(self, jobs_store: Any) -> None:
        self._store = jobs_store
        self._heartbeat_lock = threading.Lock()

    def create(
        self,
        *,
        user_id: str,
        job_type: JobType,
        input_payload: dict | None = None,
    ) -> str:
        """Write a QUEUED job row and return its id."""
        import json

        job_id = str(uuid4())
        now = _now_iso()
        job = CoachJob(
            job_id=job_id,
            user_id=user_id,
            job_type=job_type,
            status=JobStatus.QUEUED,
            stage=None,
            progress_pct=0,
            heartbeat_at=now,
            input_json=json.dumps(input_payload, ensure_ascii=False, default=str)
            if input_payload
            else None,
            created_at=now,
            updated_at=now,
        )
        self._store.create(job)
        return job_id

    def get(self, user_id: str, job_id: str) -> CoachJob | None:
        return self._store.get(user_id, job_id)

    def run(
        self,
        job_id: str,
        work_fn: Callable[..., Any],
        *,
        user_id: str,
    ) -> None:
        """Execute ``work_fn(heartbeat=...)`` under a job lifecycle.

        The work_fn receives a ``heartbeat`` callable and optional ``stage``
        helper. Any exception flips the job to FAILED with the exception
        message stamped on ``error_message``.
        """
        import json

        try:
            self._store.update(
                job_id,
                user_id,
                status=JobStatus.RUNNING,
                heartbeat_at=_now_iso(),
            )
        except KeyError:
            logger.error("job_scheduler.run: job %s missing", job_id)
            return

        def heartbeat(*, stage: JobStage | None = None, progress_pct: int | None = None) -> None:
            with self._heartbeat_lock:
                fields: dict[str, Any] = {"heartbeat_at": _now_iso()}
                if stage is not None:
                    fields["stage"] = stage
                if progress_pct is not None:
                    fields["progress_pct"] = max(0, min(100, int(progress_pct)))
                self._store.update(job_id, user_id, **fields)

        try:
            result = work_fn(heartbeat=heartbeat)
        except Exception as exc:  # noqa: BLE001 — job boundary
            logger.exception("job %s failed", job_id)
            self._store.update(
                job_id,
                user_id,
                status=JobStatus.FAILED,
                error_code=type(exc).__name__,
                error_message=str(exc),
                completed_at=_now_iso(),
                heartbeat_at=_now_iso(),
            )
            return

        update_fields: dict[str, Any] = {
            "status": JobStatus.DONE,
            "progress_pct": 100,
            "completed_at": _now_iso(),
            "heartbeat_at": _now_iso(),
        }
        if result is not None:
            update_fields["result_json"] = json.dumps(
                result, ensure_ascii=False, default=str
            )
        self._store.update(job_id, user_id, **update_fields)

    def reconcile_stale_jobs(self) -> list[str]:
        """Mark running jobs with stale heartbeats as FAILED.

        Returns the ids of the jobs that were swept. Called from the FastAPI
        ``lifespan`` hook on app startup — see plan §8.3."""
        from datetime import timedelta

        threshold = datetime.now(timezone.utc) - timedelta(seconds=STALE_HEARTBEAT_SECONDS)
        swept: list[str] = []
        for job in self._store.list_running():
            try:
                hb_dt = datetime.fromisoformat(job.heartbeat_at.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                continue
            if hb_dt < threshold:
                try:
                    self._store.update(
                        job.job_id,
                        job.user_id,
                        status=JobStatus.FAILED,
                        error_code="interrupted_by_restart",
                        error_message="Container restarted during job execution",
                        completed_at=_now_iso(),
                    )
                    swept.append(job.job_id)
                except KeyError:
                    pass
        return swept
