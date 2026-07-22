"""Durable coordination between account deletion and user-scoped jobs."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from stride_storage.interfaces.jobs import (
    JobStatus,
    PipelineRunRecord,
    PipelineRunStore,
    is_terminal,
)

logger = logging.getLogger(__name__)

DELETION_FENCE_RUN_ID = "_account-deletion"
DELETION_FENCE_PIPELINE = "account_deletion"


class AccountDeletingError(Exception):
    """Raised when work is refused because its owner is being deleted."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _run_store() -> PipelineRunStore:
    from stride_server.jobs import get_pipeline_run_store

    return get_pipeline_run_store()


def mark_deleting(user_id: str) -> None:
    """Create the durable per-user deletion fence, idempotently."""
    store = _run_store()
    if store.get(user_id, DELETION_FENCE_RUN_ID) is not None:
        return
    now = _now_iso()
    fence = PipelineRunRecord(
        run_id=DELETION_FENCE_RUN_ID,
        partition_key=user_id,
        pipeline_name=DELETION_FENCE_PIPELINE,
        status=JobStatus.CANCELLED,
        created_at=now,
        updated_at=now,
        completed_at=now,
    )
    try:
        store.create(fence)
    except Exception:
        # Azure create_entity is insert-only. A concurrent DELETE may win after
        # our initial get; confirm its fence exists and treat that conflict as
        # idempotent success without swallowing genuine storage failures.
        if store.get(user_id, DELETION_FENCE_RUN_ID) is None:
            raise
    logger.info("account-deletion fence set for user %s", user_id)


def is_deleting(user_id: str) -> bool:
    """Return whether the user's durable deletion fence exists."""
    return _run_store().get(user_id, DELETION_FENCE_RUN_ID) is not None


def cancel_active_pipeline_runs(user_id: str) -> int:
    """Cancel every non-terminal pipeline run owned by the user."""
    store = _run_store()
    now = _now_iso()
    cancelled = 0
    for run in store.list_by_partition(user_id):
        if run.run_id == DELETION_FENCE_RUN_ID or is_terminal(run.status):
            continue
        store.update(
            run.run_id,
            user_id,
            status=JobStatus.CANCELLED,
            current_step=None,
            completed_at=now,
        )
        cancelled += 1
    return cancelled


def cancel_queued_jobs(user_id: str) -> int:
    """Cancel queued jobs; their messages are acknowledged on delivery."""
    from stride_server.jobs import get_job_client

    store = get_job_client().store
    now = _now_iso()
    cancelled = 0
    for job in store.list_by_partition(user_id):
        if job.status is not JobStatus.QUEUED:
            continue
        store.update(
            job.job_id,
            user_id,
            status=JobStatus.CANCELLED,
            completed_at=now,
        )
        cancelled += 1
    return cancelled


def running_jobs(user_id: str) -> list[str]:
    """Return IDs of jobs whose handlers may still hold user resources."""
    from stride_server.jobs import get_job_client

    return [
        job.job_id
        for job in get_job_client().store.list_by_partition(user_id)
        if job.status is JobStatus.RUNNING
    ]
