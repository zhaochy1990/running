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

    Store-first: the PipelineRun row is persisted BEFORE the first step job is
    enqueued, so a worker that dequeues the step (possibly before this call
    returns) always finds the run in ``on_job_completed``. If we enqueued first,
    a fast worker — or a failed ``create`` after a successful ``enqueue`` — would
    leave an orphan job whose completion can't advance a nonexistent run.

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
    now = _now_iso()
    store = get_pipeline_run_store()
    # 1. Persist the run first (first step's job_id not known yet → None).
    store.create(PipelineRunRecord(
        run_id=run_id,
        partition_key=partition_key,
        pipeline_name=name,
        status=JobStatus.RUNNING,
        current_step=first.name,
        steps_json=_step_states(pipeline, first_job_id=None),
        created_at=now,
        updated_at=now,
    ))
    # 2. Now enqueue the first step — the run is already durable.
    first_job_id = _enqueue_step(
        enqueue, pipeline, first, run_id=run_id, partition_key=partition_key,
        input_payload=input_payload,
    )
    # 3. Backfill the first step's job_id (best-effort — completion advancement
    #    keys off the run/step, not this id, so a race here is harmless). Re-read
    #    the run so we don't clobber a fast worker that already advanced it.
    try:
        current = store.get(partition_key, run_id)
        if current is not None:
            store.update(
                run_id, partition_key,
                steps_json=_update_step_states(
                    current.steps_json, first.name, job_id=first_job_id
                ),
            )
    except Exception:  # noqa: BLE001
        logger.warning("pipeline run %s: first-step job_id backfill failed", run_id, exc_info=True)
    logger.info("pipeline %s run %s started for %s", name, run_id, partition_key)
    if name == "onboarding":
        from stride_server.jobs import onboarding_notify

        onboarding_notify.publish_started(partition_key)
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


def _step_state(steps_json: str | None, step_name: str) -> dict[str, Any] | None:
    for st in json.loads(steps_json) if steps_json else []:
        if st.get("name") == step_name:
            return st
    return None


def on_job_completed(job: JobRecord) -> None:
    """Worker hook: a step job finished DONE — advance its pipeline run.

    No-op if the job isn't part of a pipeline (no run metadata).

    **Idempotent.** The worker fires this hook BEFORE deleting the queue
    message (so pipeline advancement is covered by at-least-once retry — a
    transient store/queue error or a crash here leaves the message to be
    re-delivered rather than stranding the run). That means this can run more
    than once for the same completed step, so it must not enqueue the next step
    twice: if the recorded next step has already left ``pending`` (a prior run
    already enqueued it), we only re-assert the current step's DONE state and
    return without a second enqueue.
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
    if run.status in (JobStatus.DONE, JobStatus.FAILED):
        # Run already terminal (this step was the last, or a prior delivery
        # finished/failed the run). Nothing to advance.
        return
    pipeline = get_pipeline(run.pipeline_name)
    if pipeline is None:
        logger.error("pipeline def %s missing at runtime", run.pipeline_name)
        return

    nxt = pipeline.next_step(step_name)
    if nxt is not None:
        # Idempotency guard: if the next step was already enqueued by an earlier
        # delivery of this same completion, don't enqueue it again.
        nxt_state = _step_state(run.steps_json, nxt.name)
        if nxt_state is not None and nxt_state.get("status") != "pending":
            return

    steps_json = _update_step_states(
        run.steps_json, step_name, status=JobStatus.DONE.value, job_id=job.job_id
    )
    if nxt is None:
        store.update(
            run_id, job.partition_key,
            status=JobStatus.DONE, current_step=None,
            steps_json=steps_json, completed_at=_now_iso(),
        )
        logger.info("pipeline run %s DONE", run_id)
        _notify_run_transition(run, job, step_name, next_step=None)
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
    _notify_run_transition(run, job, step_name, next_step=nxt.name)


def _notify_run_transition(
    run: PipelineRunRecord, job: JobRecord, step_name: str, *, next_step: str | None
) -> None:
    """Emit onboarding progress notifications on a real step/run transition.

    Only for the onboarding pipeline; other pipelines don't surface here. This
    is called AFTER the idempotency guard has already advanced the run, so a
    hook replay (which returns early at that guard) won't re-emit. Best-effort —
    the notify helpers swallow their own errors.
    """
    if run.pipeline_name != "onboarding":
        return
    from stride_server.jobs import onboarding_notify

    user_id = job.partition_key
    if next_step is None:
        onboarding_notify.publish_complete(user_id)
        return
    if step_name == "full_sync":
        onboarding_notify.publish_sync_done(user_id, _synced_activities(job))
        onboarding_notify.publish_analyzing(user_id)


def _synced_activities(job: JobRecord) -> int:
    """Read the full_sync step's activity count from its result payload."""
    if not job.result_json:
        return 0
    try:
        return int(json.loads(job.result_json).get("activities", 0))
    except (json.JSONDecodeError, TypeError, ValueError):
        return 0


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
    already_failed = run.status is JobStatus.FAILED
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
    if not already_failed and run.pipeline_name == "onboarding":
        from stride_server.jobs import onboarding_notify

        onboarding_notify.publish_failed(job.partition_key, step_name)


def _run_input(run: PipelineRunRecord) -> dict[str, Any] | None:
    """Run-level input to thread into subsequent steps (none for now)."""
    return None
