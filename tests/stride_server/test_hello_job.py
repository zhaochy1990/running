"""Tests for the hello_world handler + internal job endpoints."""

from __future__ import annotations

import json

from stride_storage.interfaces.jobs import GLOBAL_PARTITION, JobRecord, JobStatus
from stride_storage.jobs import FileJobStore, InMemoryJobQueue, JobClient
from stride_server.jobs.registry import get_handler
from stride_server.jobs.worker import JobWorker
from stride_storage.interfaces.config import QueueStorageConfig


def _import_handlers():
    import stride_server.jobs.handlers  # noqa: F401 — registers hello_world


def test_hello_handler_registered_and_echoes():
    _import_handlers()
    handler = get_handler("hello_world")
    assert handler is not None
    job = JobRecord(
        job_id="j1", partition_key=GLOBAL_PARTITION, job_type="hello_world",
        status=JobStatus.RUNNING, input_json=json.dumps({"name": "x"}),
    )
    seen = {}
    def hb(*, stage=None, progress_pct=None):
        seen["stage"] = stage
    result = handler(job, heartbeat=hb)
    assert result == {"message": "hello", "echo": {"name": "x"}}
    assert seen["stage"] == "greeting"


def test_hello_job_end_to_end_through_worker(tmp_path):
    _import_handlers()
    store = FileJobStore(tmp_path / "s")
    queue = InMemoryJobQueue()
    poison = InMemoryJobQueue()
    client = JobClient(store, queue)
    jid = client.enqueue(
        job_type="hello_world", partition_key=GLOBAL_PARTITION,
        input_payload={"greet": "hi"},
    )
    cfg = QueueStorageConfig(visibility_timeout_s=0, poison_max_attempts=5)
    JobWorker(store=store, queue=queue, poison_queue=poison, config=cfg).process_once(max_messages=5)

    rec = store.get(GLOBAL_PARTITION, jid)
    assert rec.status is JobStatus.DONE
    assert rec.progress_pct == 100
    assert json.loads(rec.result_json) == {"message": "hello", "echo": {"greet": "hi"}}
