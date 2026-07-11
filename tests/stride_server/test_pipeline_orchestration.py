"""Tests for the pipeline orchestration layer (loader + store + orchestrator)."""

from __future__ import annotations

import json

import pytest

import stride_server.jobs as J
from stride_storage.interfaces.config import QueueStorageConfig
from stride_storage.interfaces.jobs import JobStatus, PipelineRunRecord
from stride_storage.jobs import (
    FileJobStore,
    FilePipelineRunStore,
    InMemoryJobQueue,
    JobClient,
)
from stride_server.jobs import orchestrator
from stride_server.jobs.pipelines import (
    PipelineConfigError,
    clear_pipelines_for_tests,
    get_pipeline,
    load_pipelines,
)
from stride_server.jobs.registry import clear_registry_for_tests, job_handler
from stride_server.jobs.worker import JobWorker


@pytest.fixture(autouse=True)
def _clean():
    clear_registry_for_tests()
    clear_pipelines_for_tests()
    yield
    clear_registry_for_tests()
    clear_pipelines_for_tests()


def _write_yaml(tmp_path, body: str):
    p = tmp_path / "pipelines.yaml"
    p.write_text(body, encoding="utf-8")
    return p


# --- loader validation ------------------------------------------------------


def test_loader_parses_and_validates(tmp_path):
    for jt in ("a", "b"):
        job_handler(jt)(lambda job, *, heartbeat: None)
    p = _write_yaml(tmp_path, """
pipelines:
  demo:
    steps:
      - name: s1
        job_type: a
      - name: s2
        job_type: b
        depends: [s1]
""")
    load_pipelines(p)
    d = get_pipeline("demo")
    assert [s.name for s in d.steps] == ["s1", "s2"]
    assert d.next_step("s1").name == "s2"
    assert d.next_step("s2") is None


def test_loader_rejects_missing_handler(tmp_path):
    p = _write_yaml(tmp_path, """
pipelines:
  demo:
    steps:
      - name: s1
        job_type: nonexistent
""")
    with pytest.raises(PipelineConfigError, match="no registered handler"):
        load_pipelines(p)


def test_loader_rejects_bad_depends(tmp_path):
    job_handler("a")(lambda job, *, heartbeat: None)
    p = _write_yaml(tmp_path, """
pipelines:
  demo:
    steps:
      - name: s1
        job_type: a
        depends: [ghost]
""")
    with pytest.raises(PipelineConfigError, match="not an earlier step"):
        load_pipelines(p)


def test_loader_rejects_bad_yaml(tmp_path):
    p = tmp_path / "pipelines.yaml"
    p.write_text("pipelines: [unclosed", encoding="utf-8")
    with pytest.raises(PipelineConfigError):
        load_pipelines(p)


# --- pipeline run store -----------------------------------------------------


def test_pipeline_run_store_roundtrip(tmp_path):
    store = FilePipelineRunStore(tmp_path / "pr")
    store.create(PipelineRunRecord(
        run_id="r1", partition_key="u1", pipeline_name="demo",
        status=JobStatus.RUNNING, current_step="s1", created_at="now", updated_at="now",
    ))
    store.update("r1", "u1", status=JobStatus.DONE, current_step=None)
    got = store.get("u1", "r1")
    assert got.status is JobStatus.DONE
    assert got.current_step is None
    assert store.update("r1", "u1", status=JobStatus.DONE)  # idempotent field ok
    with pytest.raises(AttributeError):
        store.update("r1", "u1", not_a_field=1)


# --- orchestrator end-to-end (via worker + dev backends) --------------------


def _wire_dev_backends(tmp_path, monkeypatch, *, visibility_timeout_s=0):
    cfg = QueueStorageConfig(
        file_backend_dir=str(tmp_path),
        visibility_timeout_s=visibility_timeout_s,
        poison_max_attempts=3,
    )
    store = FileJobStore(tmp_path / "state")
    queue = InMemoryJobQueue()
    poison = InMemoryJobQueue()
    client = JobClient(store, queue)
    prstore = FilePipelineRunStore(tmp_path / "pr")
    monkeypatch.setattr(J, "get_job_client", lambda: client)
    monkeypatch.setattr(J, "enqueue", lambda **kw: client.enqueue(**kw))
    monkeypatch.setattr(J, "get_pipeline_run_store", lambda: prstore)
    worker = JobWorker(
        store=store, queue=queue, poison_queue=poison, config=cfg,
        on_completed=orchestrator.on_job_completed, on_failed=orchestrator.on_job_failed,
    )
    return worker, prstore, queue


def test_pipeline_runs_all_steps_in_order(tmp_path, monkeypatch):
    order = []
    for jt in ("a", "b", "c"):
        def mk(n):
            return lambda job, *, heartbeat: (order.append(n), {"step": n})[1]
        job_handler(jt)(mk(jt))
    p = _write_yaml(tmp_path, """
pipelines:
  demo:
    steps:
      - {name: s1, job_type: a}
      - {name: s2, job_type: b, depends: [s1]}
      - {name: s3, job_type: c, depends: [s2]}
""")
    load_pipelines(p)
    worker, prstore, queue = _wire_dev_backends(tmp_path, monkeypatch)

    run_id = orchestrator.start_pipeline("demo", partition_key="u1")
    for _ in range(10):
        if worker.process_once(max_messages=5) == 0:
            break

    run = prstore.get("u1", run_id)
    assert run.status is JobStatus.DONE
    assert run.current_step is None
    assert order == ["a", "b", "c"]
    steps = json.loads(run.steps_json)
    assert [s["status"] for s in steps] == ["done", "done", "done"]


def test_pipeline_fails_when_step_fails(tmp_path, monkeypatch):
    job_handler("a")(lambda job, *, heartbeat: {"ok": True})
    def boom(job, *, heartbeat):
        raise RuntimeError("kaboom")
    job_handler("b")(boom)
    p = _write_yaml(tmp_path, """
pipelines:
  demo:
    steps:
      - {name: s1, job_type: a}
      - {name: s2, job_type: b, depends: [s1]}
""")
    load_pipelines(p)
    worker, prstore, queue = _wire_dev_backends(tmp_path, monkeypatch)

    run_id = orchestrator.start_pipeline("demo", partition_key="u1")
    for _ in range(12):
        if worker.process_once(max_messages=5) == 0:
            break

    run = prstore.get("u1", run_id)
    assert run.status is JobStatus.FAILED
    assert "s2" in (run.error_message or "")
    steps = json.loads(run.steps_json)
    assert steps[0]["status"] == "done"
    assert steps[1]["status"] == "failed"


def test_non_pipeline_job_ignored_by_hook(tmp_path, monkeypatch):
    # a plain job (no pipeline metadata) must not touch any pipeline run
    job_handler("plain")(lambda job, *, heartbeat: {"ok": True})
    worker, prstore, queue = _wire_dev_backends(tmp_path, monkeypatch)
    from stride_storage.interfaces.jobs import GLOBAL_PARTITION
    client = J.get_job_client()
    jid = client.enqueue(job_type="plain", partition_key=GLOBAL_PARTITION)
    worker.process_once(max_messages=5)
    assert client.get(GLOBAL_PARTITION, jid).status is JobStatus.DONE
    # no pipeline runs created
    assert prstore.list_by_partition(GLOBAL_PARTITION) == []


def test_run_persisted_before_first_job_enqueued(tmp_path, monkeypatch):
    """Store-first invariant: if a worker consumes + completes the first step
    the instant it's enqueued (before start_pipeline returns), the run must
    already exist so on_job_completed can advance it — not silently stall."""
    for jt in ("a", "b"):
        job_handler(jt)(lambda job, *, heartbeat: {"ok": True})
    p = _write_yaml(tmp_path, """
pipelines:
  demo:
    steps:
      - {name: s1, job_type: a}
      - {name: s2, job_type: b, depends: [s1]}
""")
    load_pipelines(p)
    # Leased visibility (>0) so the reentrant drain inside racing_enqueue can't
    # re-receive the still-un-acked parent message — the worker fires the
    # completion hook before acking, so a 0-timeout queue would hand the same
    # in-flight message back to the nested process_once and recurse.
    worker, prstore, queue = _wire_dev_backends(
        tmp_path, monkeypatch, visibility_timeout_s=300
    )
    real_client = J.get_job_client()
    real_enqueue = real_client.enqueue

    def racing_enqueue(**kw):
        jid = real_enqueue(**kw)
        worker.process_once(max_messages=5)  # consume immediately
        return jid

    monkeypatch.setattr(J, "enqueue", racing_enqueue)

    run_id = orchestrator.start_pipeline("demo", partition_key="u1")
    # drain any remaining
    for _ in range(6):
        if worker.process_once(max_messages=5) == 0:
            break

    run = prstore.get("u1", run_id)
    assert run is not None  # run existed when the first job completed
    assert run.status is JobStatus.DONE  # advanced past both steps, not stalled


def test_completion_hook_failure_leaves_message_for_redelivery(tmp_path, monkeypatch):
    """If the completion hook (pipeline advance) fails, the step's message must
    NOT be acked — its lease expires and the job is re-delivered, so the
    pipeline can still advance on retry instead of stranding at this step."""
    job_handler("a")(lambda job, *, heartbeat: {"ok": True})
    job_handler("b")(lambda job, *, heartbeat: {"ok": True})
    p = _write_yaml(tmp_path, """
pipelines:
  demo:
    steps:
      - {name: s1, job_type: a}
      - {name: s2, job_type: b, depends: [s1]}
""")
    load_pipelines(p)
    # timeout=0 so a re-delivery is observable within the same drain loop.
    worker, prstore, queue = _wire_dev_backends(tmp_path, monkeypatch)

    run_id = orchestrator.start_pipeline("demo", partition_key="u1")

    calls = {"n": 0}
    real_hook = orchestrator.on_job_completed

    def flaky_hook(job):
        # Fail the first advance of s1, then behave normally.
        if job.job_type == "a" and calls["n"] == 0:
            calls["n"] += 1
            raise RuntimeError("transient store error")
        return real_hook(job)

    worker._on_completed = flaky_hook

    for _ in range(12):
        if worker.process_once(max_messages=5) == 0:
            break

    # The first advance failed, but s1's message survived and re-delivered, so
    # the run still reached the end rather than stalling at s1.
    assert calls["n"] == 1  # the hook did fail once
    run = prstore.get("u1", run_id)
    assert run.status is JobStatus.DONE


def test_on_job_completed_is_idempotent(tmp_path, monkeypatch):
    """Firing the completion hook twice for the same step must not enqueue the
    next step twice (the worker fires before ack, so a redelivery re-runs it)."""
    job_handler("a")(lambda job, *, heartbeat: {"ok": True})
    job_handler("b")(lambda job, *, heartbeat: {"ok": True})
    p = _write_yaml(tmp_path, """
pipelines:
  demo:
    steps:
      - {name: s1, job_type: a}
      - {name: s2, job_type: b, depends: [s1]}
""")
    load_pipelines(p)
    worker, prstore, queue = _wire_dev_backends(tmp_path, monkeypatch)

    enqueued: list[str] = []
    real_enqueue = J.enqueue

    def counting_enqueue(**kw):
        enqueued.append(kw["job_type"])
        return real_enqueue(**kw)

    monkeypatch.setattr(J, "enqueue", counting_enqueue)

    run_id = orchestrator.start_pipeline("demo", partition_key="u1")
    # Process only s1 (one message), then replay its completion hook by hand.
    worker.process_once(max_messages=1)
    s1_job = _find_job(worker, "u1", "a")
    before = enqueued.count("b")
    orchestrator.on_job_completed(s1_job)  # second delivery of the same step
    orchestrator.on_job_completed(s1_job)  # third, for good measure
    after = enqueued.count("b")

    assert before == 1  # s2 enqueued exactly once during normal processing
    assert after == before  # replays did NOT enqueue s2 again


def _find_job(worker, partition_key, job_type):
    for rec in worker._store.list_by_partition(partition_key):
        if rec.job_type == job_type:
            return rec
    raise AssertionError(f"no {job_type} job for {partition_key}")
