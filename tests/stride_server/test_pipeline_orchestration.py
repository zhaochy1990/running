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


def _wire_dev_backends(tmp_path, monkeypatch):
    cfg = QueueStorageConfig(
        file_backend_dir=str(tmp_path), visibility_timeout_s=0, poison_max_attempts=3
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
