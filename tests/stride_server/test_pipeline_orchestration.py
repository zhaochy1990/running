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


def test_default_onboarding_pipeline_serializes_all_sqlite_writers():
    from stride_server.jobs.handlers import ensure_handlers_registered

    ensure_handlers_registered()
    pipelines = load_pipelines()

    assert [step.name for step in pipelines["onboarding"].steps] == [
        "health_sync",
        "full_sync",
        "calibration",
        "backfill",
    ]


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
    from stride_server.jobs import account_deletion
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
        is_cancelled=lambda job: account_deletion.is_deleting(job.partition_key),
        on_cancelled=orchestrator.on_job_cancelled,
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


# --- cancellation fence -----------------------------------------------------


def test_mark_deleting_treats_concurrent_create_conflict_as_success(monkeypatch):
    """A second DELETE racing the Azure insert observes the winning fence."""
    from stride_server.jobs import account_deletion

    class RaceStore:
        def __init__(self):
            self.fence = None
            self.get_calls = 0

        def get(self, partition_key, run_id):
            self.get_calls += 1
            return None if self.get_calls == 1 else self.fence

        def create(self, run):
            self.fence = run
            raise RuntimeError("entity already exists")

    store = RaceStore()
    monkeypatch.setattr(account_deletion, "_run_store", lambda: store)

    account_deletion.mark_deleting("u1")

    assert store.fence is not None
    assert store.fence.status is JobStatus.CANCELLED


def test_start_pipeline_refuses_when_user_fenced(tmp_path, monkeypatch):
    """A fenced user (account deletion in progress) must not get a new pipeline
    run or any enqueued job — start_pipeline raises before creating anything."""
    from stride_server.jobs import account_deletion

    job_handler("a")(lambda job, *, heartbeat: {"ok": True})
    p = _write_yaml(tmp_path, """
pipelines:
  onboarding:
    steps:
      - {name: full_sync, job_type: a}
""")
    load_pipelines(p)
    worker, prstore, queue = _wire_dev_backends(tmp_path, monkeypatch)

    # Fence u1.
    account_deletion.mark_deleting("u1")

    with pytest.raises(account_deletion.AccountDeletingError):
        orchestrator.start_pipeline("onboarding", partition_key="u1")

    # No non-fence run created, nothing enqueued.
    runs = [r for r in prstore.list_by_partition("u1")
            if r.run_id != account_deletion.DELETION_FENCE_RUN_ID]
    assert runs == []
    assert queue.depth() == 0


def test_on_job_completed_stops_advancing_when_fenced(tmp_path, monkeypatch):
    """A completion race: the fence lands after full_sync finished. The hook must
    NOT enqueue the next step and must mark the run CANCELLED."""
    from stride_server.jobs import account_deletion

    order = []
    for jt in ("a", "b"):
        def mk(n):
            return lambda job, *, heartbeat: (order.append(n), {"step": n})[1]
        job_handler(jt)(mk(jt))
    p = _write_yaml(tmp_path, """
pipelines:
  onboarding:
    steps:
      - {name: full_sync, job_type: a}
      - {name: calibration, job_type: b, depends: [full_sync]}
""")
    load_pipelines(p)
    worker, prstore, queue = _wire_dev_backends(tmp_path, monkeypatch)

    from stride_server.jobs import onboarding_notify
    for name in ("publish_started", "publish_complete", "publish_sync_done",
                 "publish_analyzing", "publish_syncing", "publish_failed"):
        monkeypatch.setattr(onboarding_notify, name, lambda *a, **k: None)

    run_id = orchestrator.start_pipeline("onboarding", partition_key="u1")
    # Process only the first step, then fence before draining the rest.
    worker.process_once(max_messages=1)
    account_deletion.mark_deleting("u1")
    for _ in range(6):
        if worker.process_once(max_messages=5) == 0:
            break

    run = prstore.get("u1", run_id)
    assert run.status is JobStatus.CANCELLED
    assert order == ["a"]  # calibration never ran


def test_on_job_cancelled_marks_run_cancelled_without_failure_notify(tmp_path, monkeypatch):
    """When a step job is cancelled, on_job_cancelled marks its run CANCELLED and
    does NOT emit an onboarding failure notification."""
    from stride_storage.interfaces.jobs import JobRecord
    from stride_server.jobs import onboarding_notify

    job_handler("a")(lambda job, *, heartbeat: {"ok": True})
    job_handler("b")(lambda job, *, heartbeat: {"ok": True})
    p = _write_yaml(tmp_path, """
pipelines:
  onboarding:
    steps:
      - {name: full_sync, job_type: a}
      - {name: calibration, job_type: b}
""")
    load_pipelines(p)
    worker, prstore, queue = _wire_dev_backends(tmp_path, monkeypatch)
    run_id = orchestrator.start_pipeline("onboarding", partition_key="u1")

    failed_notify: list = []
    monkeypatch.setattr(onboarding_notify, "publish_failed", lambda *a, **k: failed_notify.append(a))

    # Build the cancelled step job record as the worker would hand it to the hook.
    import json as _json
    cancelled_job = JobRecord(
        job_id="j-full", partition_key="u1", job_type="a",
        status=JobStatus.CANCELLED,
        input_json=_json.dumps({"pipeline_run_id": run_id, "step_name": "full_sync"}),
    )
    orchestrator.on_job_cancelled(cancelled_job)

    run = prstore.get("u1", run_id)
    assert run.status is JobStatus.CANCELLED
    assert failed_notify == []  # no failure notification for a cancellation


def test_failed_hook_does_not_overwrite_cancelled_run(tmp_path, monkeypatch):
    """A late failure cannot reverse an account-deletion cancellation."""
    from stride_server.jobs import account_deletion, onboarding_notify

    job_handler("a")(lambda job, *, heartbeat: {"ok": True})
    p = _write_yaml(tmp_path, """
pipelines:
  onboarding:
    steps:
      - {name: full_sync, job_type: a}
""")
    load_pipelines(p)
    worker, prstore, _queue = _wire_dev_backends(tmp_path, monkeypatch)
    run_id = orchestrator.start_pipeline("onboarding", partition_key="u1")
    failed_job = _find_job(worker, "u1", "a")

    account_deletion.mark_deleting("u1")
    account_deletion.cancel_active_pipeline_runs("u1")
    failed_job = worker._store.update(
        failed_job.job_id,
        "u1",
        status=JobStatus.FAILED,
        error_message="late failure",
    )
    notifications: list[tuple[str, str]] = []
    monkeypatch.setattr(
        onboarding_notify,
        "publish_failed",
        lambda user, step: notifications.append((user, step)),
    )

    orchestrator.on_job_failed(failed_job)

    assert prstore.get("u1", run_id).status is JobStatus.CANCELLED
    assert notifications == []


def test_start_pipeline_emits_started_for_onboarding(tmp_path, monkeypatch):
    """start_pipeline publishes the 'started' notification for the onboarding
    pipeline (immediate visibility, API process) but not for other pipelines."""
    job_handler("a")(lambda job, *, heartbeat: {"ok": True})
    p = _write_yaml(tmp_path, """
pipelines:
  onboarding:
    steps:
      - {name: full_sync, job_type: a}
  other:
    steps:
      - {name: s1, job_type: a}
""")
    load_pipelines(p)
    _wire_dev_backends(tmp_path, monkeypatch)

    started: list[str] = []
    from stride_server.jobs import onboarding_notify
    monkeypatch.setattr(onboarding_notify, "publish_started", lambda u: started.append(u))

    orchestrator.start_pipeline("other", partition_key="u1")
    assert started == []  # non-onboarding pipeline → no notification

    orchestrator.start_pipeline("onboarding", partition_key="u2")
    assert started == ["u2"]
