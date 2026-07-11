"""Internal job endpoints — smoke-test surface for the async-job infra.

Two X-Internal-Token routes let a deployment smoke test drive the whole
pipeline (enqueue → worker consumes → DONE) without a user JWT:

  POST /internal/jobs/hello            — enqueue a hello_world job, return job_id
  GET  /internal/jobs/{partition}/{id} — read that job's current state

These are intentionally generic over the job infra (not hello-specific on the
read side) so they double as a minimal ops/debug surface.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from stride_storage.interfaces.jobs import GLOBAL_PARTITION

from .plan import require_internal_token

internal_router = APIRouter()

_HELLO_JOB_TYPE = "hello_world"


@internal_router.post("/internal/jobs/hello")
def internal_enqueue_hello(
    payload: dict[str, Any] | None = None,
    _token: None = Depends(require_internal_token),
) -> dict:
    """Enqueue a hello_world job (global partition). Returns its job_id.

    The worker's registered ``hello_world`` handler echoes ``payload`` back as
    the job result. Poll ``GET /internal/jobs/{partition}/{job_id}`` for status.
    """
    from stride_server.jobs import enqueue

    job_id = enqueue(
        job_type=_HELLO_JOB_TYPE,
        partition_key=GLOBAL_PARTITION,
        input_payload=payload or {},
    )
    return {"job_id": job_id, "partition_key": GLOBAL_PARTITION}


@internal_router.get("/internal/jobs/{partition_key}/{job_id}")
def internal_get_job(
    partition_key: str,
    job_id: str,
    _token: None = Depends(require_internal_token),
) -> dict:
    """Return the current state of a job by (partition_key, job_id)."""
    from stride_server.jobs import get_job_client

    job = get_job_client().get(partition_key, job_id)
    if job is None:
        return {"found": False}
    return {
        "found": True,
        "job_id": job.job_id,
        "partition_key": job.partition_key,
        "job_type": job.job_type,
        "status": job.status.value,
        "progress_pct": job.progress_pct,
        "stage": job.stage,
        "attempts": job.attempts,
        "result_json": job.result_json,
        "error_code": job.error_code,
        "error_message": job.error_message,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "completed_at": job.completed_at,
    }
