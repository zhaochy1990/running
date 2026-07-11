"""Tests for the generic async-job infra (state store + queue + worker)."""

from __future__ import annotations

import pytest

from stride_storage.interfaces.config import QueueStorageConfig
from stride_storage.interfaces.jobs import JobRecord, JobStatus
from stride_storage.jobs import FileJobStore, InMemoryJobQueue, JobClient
from stride_server.jobs.registry import (
    clear_registry_for_tests,
    get_handler,
    job_handler,
)
from stride_server.jobs.worker import JobWorker


@pytest.fixture
def store(tmp_path):
    return FileJobStore(tmp_path / "state")


@pytest.fixture
def queue():
    return InMemoryJobQueue()


@pytest.fixture(autouse=True)
def _clean_registry():
    clear_registry_for_tests()
    yield
    clear_registry_for_tests()


# --- state store ------------------------------------------------------------


def test_store_create_get_roundtrip(store):
    rec = JobRecord(
        job_id="j1", partition_key="u1", job_type="t", status=JobStatus.QUEUED,
        created_at="now", updated_at="now",
    )
    store.create(rec)
    got = store.get("u1", "j1")
    assert got is not None
    assert got.job_type == "t"
    assert got.status is JobStatus.QUEUED


def test_store_update_unknown_field_raises(store):
    store.create(JobRecord(job_id="j1", partition_key="u1", job_type="t", status=JobStatus.QUEUED))
    with pytest.raises(AttributeError):
        store.update("j1", "u1", not_a_field=1)


def test_store_list_running_filters(store):
    store.create(JobRecord(job_id="a", partition_key="u1", job_type="t", status=JobStatus.RUNNING))
    store.create(JobRecord(job_id="b", partition_key="u1", job_type="t", status=JobStatus.DONE))
    running = store.list_running()
    assert [r.job_id for r in running] == ["a"]


# --- queue ------------------------------------------------------------------


def test_queue_receive_hides_then_retries_until_deleted(queue):
    queue.enqueue(job_id="j1", partition_key="u1")
    first = queue.receive(max=5, visibility_timeout_s=300)
    assert len(first) == 1 and first[0].dequeue_count == 1
    # still leased (vis=300) → not visible again
    assert queue.receive(max=5, visibility_timeout_s=300) == []


def test_queue_message_reappears_after_visibility(queue):
    queue.enqueue(job_id="j1", partition_key="u1")
    queue.receive(max=5, visibility_timeout_s=0)  # immediately visible again
    again = queue.receive(max=5, visibility_timeout_s=0)
    assert len(again) == 1 and again[0].dequeue_count == 2
    queue.delete(again[0])
    assert queue.receive(max=5, visibility_timeout_s=0) == []


# --- client -----------------------------------------------------------------


def test_client_enqueue_writes_queued_row_and_message(store, queue):
    client = JobClient(store, queue)
    jid = client.enqueue(partition_key="u1", job_type="t", input_payload={"x": 1})
    rec = store.get("u1", jid)
    assert rec.status is JobStatus.QUEUED
    assert '"x": 1' in (rec.input_json or "")
    assert queue.depth() == 1


def test_client_enqueue_defaults_to_global_partition(store, queue):
    from stride_storage.interfaces.jobs import GLOBAL_PARTITION

    client = JobClient(store, queue)
    jid = client.enqueue(job_type="periodic")  # no partition_key
    rec = store.get(GLOBAL_PARTITION, jid)
    assert rec is not None
    assert rec.partition_key == GLOBAL_PARTITION
    # global + user jobs are isolated by partition
    client.enqueue(partition_key="u1", job_type="periodic")
    assert len(store.list_by_partition(GLOBAL_PARTITION)) == 1
    assert len(store.list_by_partition("u1")) == 1


# --- worker -----------------------------------------------------------------


def _worker(store, queue, poison, **cfg):
    config = QueueStorageConfig(visibility_timeout_s=0, poison_max_attempts=3, **cfg)
    return JobWorker(store=store, queue=queue, poison_queue=poison, config=config)


def test_worker_runs_handler_to_done(store, queue):
    seen = {}

    @job_handler("ok_job")
    def _h(job, *, heartbeat):
        heartbeat(stage="s", progress_pct=50)
        return {"user": job.partition_key}

    client = JobClient(store, queue)
    jid = client.enqueue(partition_key="u1", job_type="ok_job")
    poison = InMemoryJobQueue()
    _worker(store, queue, poison).process_once(max_messages=5)

    rec = store.get("u1", jid)
    assert rec.status is JobStatus.DONE
    assert rec.progress_pct == 100
    assert '"user": "u1"' in (rec.result_json or "")
    assert queue.depth() == 0


def test_worker_no_handler_fails_job(store, queue):
    client = JobClient(store, queue)
    jid = client.enqueue(partition_key="u1", job_type="unregistered")
    poison = InMemoryJobQueue()
    _worker(store, queue, poison).process_once(max_messages=5)
    rec = store.get("u1", jid)
    assert rec.status is JobStatus.FAILED
    assert rec.error_code == "no_handler"


def test_worker_poisons_after_ceiling(store, queue):
    @job_handler("boom")
    def _h(job, *, heartbeat):
        raise RuntimeError("kaboom")

    client = JobClient(store, queue)
    jid = client.enqueue(partition_key="u1", job_type="boom")
    poison = InMemoryJobQueue()
    worker = _worker(store, queue, poison)
    for _ in range(6):
        worker.process_once(max_messages=5)
        if store.get("u1", jid).error_code == "poison":
            break
    rec = store.get("u1", jid)
    assert rec.status is JobStatus.FAILED
    assert rec.error_code == "poison"
    assert poison.depth() == 1
    assert queue.depth() == 0


def test_registry_rejects_duplicate():
    @job_handler("dup")
    def _a(job, *, heartbeat):
        return None

    with pytest.raises(ValueError):
        @job_handler("dup")
        def _b(job, *, heartbeat):
            return None
