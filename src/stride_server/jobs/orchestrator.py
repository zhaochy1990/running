"""Pipeline orchestrator — advances a linear pipeline across step jobs.

Lives in ``stride_server`` (domain logic), runs in BOTH processes:
- worker process: the worker's job-completion/-failure hooks call
  ``on_job_completed`` / ``on_job_failed`` to advance the pipeline (enqueue the
  next step, or mark the run terminal).
- API process: ``start_pipeline`` kicks a run off; status routes read the run.

Step jobs carry ``{"pipeline_run_id", "step_name"}`` in their input payload so a
completed job can be traced back to its run + step. A job WITHOUT that metadata
(e.g. the hello smoke job) is not part of a pipeline and the hooks ignore it.

Linear-only today: on a step's completion, enqueue the next step in declaration
order. The ``depends`` field in the definition is validated at load time; the
runner does not yet schedule by dependency (that's the future parallel/DAG
extension point).
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from stride_storage.interfaces.jobs import JobRecord, JobStatus, PipelineRunRecord

from .pipelines import PipelineDef, PipelineStep, get_pipeline

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _step_states(pipeline: PipelineDef, *, first_job_id: str) -> str:
    states = []
    for i, s in enumerate(pipeline.steps):
        states.append({
            "name": s.name,
            "job_type": s.job_type,
            "status": JobStatus.QUEUED.value if i == 0 else "pending",
            "job_id": first_job_id if i == 0 else None,
        })
    return json.dumps(states, ensure_ascii=False)


def _update_step_states(steps_json: str | None, step_name: str, **fields: Any) -> str:
    states = json.loads(steps_json) if steps_json else []
    for st in states:
        if st.get("name") == step_name:
            st.update(fields)
    return json.dumps(states, ensure_ascii=False)


def _pipeline_meta(job: JobRecord) -> tuple[str, str] | None:
    """Extract ``(pipeline_run_id, step_name)`` from a job's input, or None."""
    if not job.input_json:
        return None
    try:
        payload = json.loads(job.input_json)
    except json.JSONDecodeError:
        return None
    run_id = payload.get("pipeline_run_id")
    step_name = payload.get("step_name")
    if run_id and step_name:
        return str(run_id), str(step_name)
    return None


def start_pipeline(
    name: str,
    *,
    partition_key: str,
    input_payload: dict[str, Any] | None = None,
) -> str:
    """Create a pipeline run and enqueue its first step. Returns run_id.

    ``input_payload`` is merged into every step job's payload (alongside the
    ``pipeline_run_id`` / ``step_name`` metadata) so steps can read run-level
    inputs.
    """
    from stride_server.jobs import enqueue, get_pipeline_run_store

    pipeline = get_pipeline(name)
    if pipeline is None:
        raise ValueError(f"unknown pipeline: {name!r}")

    run_id = str(uuid4())
    first = pipeline.first_step()
    first_job_id = _enqueue_step(
        enqueue, pipeline, first, run_id=run_id, partition_key=partition_key,
        input_payload=input_payload,
    )
    now = _now_iso()
    get_pipeline_run_store().create(PipelineRunRecord(
        run_id=run_id,
        partition_key=partition_key,
        pipeline_name=name,
        status=JobStatus.RUNNING,
        current_step=first.name,
        steps_json=_step_states(pipeline, first_job_id=first_job_id),
        created_at=now,
        updated_at=now,
    ))
    logger.info("pipeline %s run %s started for %s", name, run_id, partition_key)
    return run_id


def _enqueue_step(
    enqueue: Any,
    pipeline: PipelineDef,
    step: PipelineStep,
    *,
    run_id: str,
    partition_key: str,
    input_payload: dict[str, Any] | None,
) -> str:
    payload = dict(input_payload or {})
    payload["pipeline_run_id"] = run_id
    payload["step_name"] = step.name
    payload["pipeline_name"] = pipeline.name
    return enqueue(
        job_type=step.job_type,
        partition_key=partition_key,
        input_payload=payload,
    )


def on_job_completed(job: JobRecord) -> None:
    """Worker hook: a step job finished DONE — advance its pipeline run.

    No-op if the job isn't part of a pipeline (no run metadata).
    """
    meta = _pipeline_meta(job)
    if meta is None:
        return
    run_id, step_name = meta
    from stride_server.jobs import enqueue, get_pipeline_run_store

    store = get_pipeline_run_store()
    run = store.get(job.partition_key, run_id)
    if run is None:
        logger.warning("pipeline run %s missing for completed step %s", run_id, step_name)
        return
    pipeline = get_pipeline(run.pipeline_name)
    if pipeline is None:
        logger.error("pipeline def %s missing at runtime", run.pipeline_name)
        return

    steps_json = _update_step_states(
        run.steps_json, step_name, status=JobStatus.DONE.value, job_id=job.job_id
    )
    nxt = pipeline.next_step(step_name)
    if nxt is None:
        store.update(
            run_id, job.partition_key,
            status=JobStatus.DONE, current_step=None,
            steps_json=steps_json, completed_at=_now_iso(),
        )
        logger.info("pipeline run %s DONE", run_id)
        return

    next_job_id = _enqueue_step(
        enqueue, pipeline, nxt, run_id=run_id, partition_key=job.partition_key,
        input_payload=_run_input(run),
    )
    steps_json = _update_step_states(
        steps_json, nxt.name, status=JobStatus.QUEUED.value, job_id=next_job_id
    )
    store.update(
        run_id, job.partition_key,
        current_step=nxt.name, steps_json=steps_json,
    )
    logger.info("pipeline run %s advanced %s -> %s", run_id, step_name, nxt.name)


def on_job_failed(job: JobRecord) -> None:
    """Worker hook: a step job reached terminal FAILED — fail the pipeline run."""
    meta = _pipeline_meta(job)
    if meta is None:
        return
    run_id, step_name = meta
    from stride_server.jobs import get_pipeline_run_store

    store = get_pipeline_run_store()
    run = store.get(job.partition_key, run_id)
    if run is None:
        return
    steps_json = _update_step_states(
        run.steps_json, step_name, status=JobStatus.FAILED.value, job_id=job.job_id
    )
    store.update(
        run_id, job.partition_key,
        status=JobStatus.FAILED,
        steps_json=steps_json,
        error_message=f"step {step_name} failed: {job.error_message or job.error_code}",
        completed_at=_now_iso(),
    )
    logger.warning("pipeline run %s FAILED at step %s", run_id, step_name)


def _run_input(run: PipelineRunRecord) -> dict[str, Any] | None:
    """Run-level input to thread into subsequent steps (none for now)."""
    return None
