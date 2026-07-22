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


def test_worker_completion_hook_failure_keeps_message(store, queue):
    """A failing on_completed hook must NOT ack the message — it stays queued so
    the job is re-delivered and the hook (which advances a pipeline) can retry.
    The job row is still marked DONE; only the ack is withheld."""
    @job_handler("hooked")
    def _h(job, *, heartbeat):
        return {"ok": True}

    client = JobClient(store, queue)
    jid = client.enqueue(partition_key="u1", job_type="hooked")
    poison = InMemoryJobQueue()

    def boom(_job):
        raise RuntimeError("transient advance error")

    config = QueueStorageConfig(visibility_timeout_s=300, poison_max_attempts=3)
    worker = JobWorker(
        store=store, queue=queue, poison_queue=poison, config=config,
        on_completed=boom,
    )
    worker.process_once(max_messages=5)

    assert store.get("u1", jid).status is JobStatus.DONE  # row finalized
    assert queue.depth() == 1  # message NOT acked — left for re-delivery


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


def test_worker_heartbeat_renews_queue_lease(store, queue):
    """Each heartbeat call extends the in-flight message's visibility.

    A long handler that outlives the initial visibility must not have its
    message re-delivered; the worker renews the lease on every heartbeat.
    """
    renewals: list[int] = []

    class _SpyQueue:
        def __init__(self, inner):
            self._inner = inner

        def receive(self, **kw):
            return self._inner.receive(**kw)

        def delete(self, message):
            return self._inner.delete(message)

        def enqueue(self, **kw):
            return self._inner.enqueue(**kw)

        def extend_visibility(self, message, *, visibility_timeout_s):
            renewals.append(visibility_timeout_s)
            return self._inner.extend_visibility(
                message, visibility_timeout_s=visibility_timeout_s
            )

    @job_handler("beat_job")
    def _h(job, *, heartbeat):
        heartbeat(stage="a", progress_pct=10)
        heartbeat(stage="b", progress_pct=90)
        return None

    spy = _SpyQueue(queue)
    client = JobClient(store, spy)
    jid = client.enqueue(partition_key="u1", job_type="beat_job")
    poison = InMemoryJobQueue()
    _worker(store, spy, poison).process_once(max_messages=5)

    assert store.get("u1", jid).status is JobStatus.DONE
    assert len(renewals) == 2  # one renewal per heartbeat
    assert queue.depth() == 0  # message acked despite renewals


def test_worker_no_handler_fails_job(store, queue):
    client = JobClient(store, queue)
    jid = client.enqueue(partition_key="u1", job_type="unregistered")
    poison = InMemoryJobQueue()
    _worker(store, queue, poison).process_once(max_messages=5)
    rec = store.get("u1", jid)
    assert rec.status is JobStatus.FAILED
    assert rec.error_code == "no_handler"


def test_worker_retrying_job_stays_queued_not_failed(store, queue):
    """A handler error while retries remain must leave the job QUEUED (in
    flight), not FAILED — else a poller sees a transient failure as terminal."""
    @job_handler("boom")
    def _h(job, *, heartbeat):
        raise RuntimeError("kaboom")

    client = JobClient(store, queue)
    jid = client.enqueue(partition_key="u1", job_type="boom")
    poison = InMemoryJobQueue()
    worker = _worker(store, queue, poison)  # poison_max_attempts=3

    worker.process_once(max_messages=5)  # attempt 1 fails, retries remain
    rec = store.get("u1", jid)
    assert rec.status is JobStatus.QUEUED  # NOT FAILED — still retrying
    assert rec.error_code == "RuntimeError"  # last error stamped for diagnostics
    assert queue.depth() == 1  # message left for redelivery
    assert poison.depth() == 0


def test_worker_permanent_failure_goes_terminal_and_dead_letters(store, queue):
    @job_handler("boom")
    def _h(job, *, heartbeat):
        raise RuntimeError("kaboom")

    client = JobClient(store, queue)
    jid = client.enqueue(partition_key="u1", job_type="boom")
    poison = InMemoryJobQueue()
    worker = _worker(store, queue, poison)  # ceiling=3
    for _ in range(6):
        worker.process_once(max_messages=5)
        if store.get("u1", jid).status is JobStatus.FAILED:
            break
    rec = store.get("u1", jid)
    assert rec.status is JobStatus.FAILED  # terminal after retries exhausted
    assert rec.error_code == "RuntimeError"  # the real error, not a generic tag
    assert rec.completed_at  # terminal state stamped
    assert poison.depth() == 1  # dead-lettered
    assert queue.depth() == 0  # main queue drained


def test_worker_flaky_handler_succeeds_and_clears_error(store, queue):
    """Regression: a handler that fails once then succeeds must end DONE with
    NO leftover error_code/error_message from the failed attempt."""
    calls = {"n": 0}

    @job_handler("flaky")
    def _h(job, *, heartbeat):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("transient")
        return {"ok": True}

    client = JobClient(store, queue)
    jid = client.enqueue(partition_key="u1", job_type="flaky")
    poison = InMemoryJobQueue()
    worker = _worker(store, queue, poison)

    worker.process_once(max_messages=5)  # attempt 1 fails → QUEUED
    mid = store.get("u1", jid)
    assert mid.status is JobStatus.QUEUED
    assert mid.error_code == "RuntimeError"

    worker.process_once(max_messages=5)  # attempt 2 succeeds → DONE
    rec = store.get("u1", jid)
    assert rec.status is JobStatus.DONE
    assert rec.error_code is None  # cleared — not stale from attempt 1
    assert rec.error_message is None
    assert '"ok": true' in (rec.result_json or "")
    assert queue.depth() == 0


def test_worker_cancels_queued_message_before_handler_runs(store, queue):
    """A queued job whose owner is fenced must never reach its handler: the
    worker marks it CANCELLED, acks the message, and does not poison it."""
    ran = {"n": 0}

    @job_handler("cancelme")
    def _h(job, *, heartbeat):
        ran["n"] += 1
        return {"ok": True}

    client = JobClient(store, queue)
    jid = client.enqueue(partition_key="u1", job_type="cancelme")
    poison = InMemoryJobQueue()
    config = QueueStorageConfig(visibility_timeout_s=0, poison_max_attempts=3)
    worker = JobWorker(
        store=store, queue=queue, poison_queue=poison, config=config,
        is_cancelled=lambda job: True,
    )
    worker.process_once(max_messages=5)

    assert ran["n"] == 0  # handler never invoked
    assert store.get("u1", jid).status is JobStatus.CANCELLED
    assert queue.depth() == 0  # acked
    assert poison.depth() == 0  # NOT poisoned


def test_worker_never_restarts_already_cancelled_message(store, queue):
    """A redelivered CANCELLED row is terminal even if the fence read fails."""
    ran = {"n": 0}

    @job_handler("cancelled")
    def _h(job, *, heartbeat):
        ran["n"] += 1
        return {"ok": True}

    client = JobClient(store, queue)
    jid = client.enqueue(partition_key="u1", job_type="cancelled")
    store.update(jid, "u1", status=JobStatus.CANCELLED)
    poison = InMemoryJobQueue()

    def unavailable(_job):
        raise RuntimeError("pipeline store unavailable")

    worker = JobWorker(
        store=store,
        queue=queue,
        poison_queue=poison,
        config=QueueStorageConfig(visibility_timeout_s=0, poison_max_attempts=3),
        is_cancelled=unavailable,
    )
    worker.process_once(max_messages=5)

    assert ran["n"] == 0
    assert store.get("u1", jid).status is JobStatus.CANCELLED
    assert queue.depth() == 0
    assert poison.depth() == 0


def test_worker_defers_job_when_cancel_check_is_unavailable(store, queue):
    """An unknown fence state must never fail open and run a user-scoped job."""
    ran = {"n": 0}

    @job_handler("deferred")
    def _h(job, *, heartbeat):
        ran["n"] += 1
        return {"ok": True}

    client = JobClient(store, queue)
    jid = client.enqueue(partition_key="u1", job_type="deferred")
    poison = InMemoryJobQueue()

    def unavailable(_job):
        raise RuntimeError("pipeline store unavailable")

    worker = JobWorker(
        store=store,
        queue=queue,
        poison_queue=poison,
        config=QueueStorageConfig(visibility_timeout_s=0, poison_max_attempts=3),
        is_cancelled=unavailable,
    )
    worker.process_once(max_messages=5)

    assert ran["n"] == 0
    assert store.get("u1", jid).status is JobStatus.QUEUED
    assert queue.depth() == 1
    assert poison.depth() == 0


def test_worker_cancels_after_running_when_fence_appears_mid_flight(store, queue):
    """Fence appears after the job is marked RUNNING (TOCTOU window): the worker
    re-checks and cancels rather than running the handler; on_cancelled fires."""
    ran = {"n": 0}
    fence = {"on": False}

    @job_handler("racy")
    def _h(job, *, heartbeat):
        ran["n"] += 1
        return {"ok": True}

    def is_cancelled(job):
        # Not cancelled at the pre-handler check, but yes at the post-RUNNING
        # re-check — simulates the fence landing in the TOCTOU window.
        if not fence["on"]:
            fence["on"] = True
            return False
        return True

    cancelled_hook: list[str] = []
    client = JobClient(store, queue)
    jid = client.enqueue(partition_key="u1", job_type="racy")
    poison = InMemoryJobQueue()
    config = QueueStorageConfig(visibility_timeout_s=0, poison_max_attempts=3)
    worker = JobWorker(
        store=store, queue=queue, poison_queue=poison, config=config,
        is_cancelled=is_cancelled,
        on_cancelled=lambda job: cancelled_hook.append(job.job_id),
    )
    worker.process_once(max_messages=5)

    assert ran["n"] == 0
    assert store.get("u1", jid).status is JobStatus.CANCELLED
    assert cancelled_hook == [jid]
    assert queue.depth() == 0
    assert poison.depth() == 0


def test_worker_leaves_message_when_cancel_hook_fails(store, queue):
    """If the on_cancelled hook fails, the message is left for re-delivery so the
    cancellation finalization can retry (mirrors the completion-hook contract)."""
    @job_handler("cancelme")
    def _h(job, *, heartbeat):
        return {"ok": True}

    client = JobClient(store, queue)
    client.enqueue(partition_key="u1", job_type="cancelme")
    poison = InMemoryJobQueue()
    config = QueueStorageConfig(visibility_timeout_s=300, poison_max_attempts=3)

    def boom(_job):
        raise RuntimeError("transient cancel-hook error")

    worker = JobWorker(
        store=store, queue=queue, poison_queue=poison, config=config,
        is_cancelled=lambda job: True,
        on_cancelled=boom,
    )
    worker.process_once(max_messages=5)

    assert queue.depth() == 1  # left for re-delivery
    assert poison.depth() == 0


def test_worker_heartbeat_cancels_running_handler(store, queue):
    """A long handler that heartbeats after the fence lands gets JobCancelled
    raised from within heartbeat; the worker finalizes it CANCELLED."""
    from stride_server.jobs.cancellation import JobCancelled

    fence = {"on": False}

    @job_handler("longjob")
    def _h(job, *, heartbeat):
        # First heartbeat is fine; then the fence lands and the next raises.
        heartbeat(stage="a", progress_pct=10)
        fence["on"] = True
        heartbeat(stage="b", progress_pct=20)  # should raise JobCancelled
        return {"ok": True}

    client = JobClient(store, queue)
    jid = client.enqueue(partition_key="u1", job_type="longjob")
    poison = InMemoryJobQueue()
    config = QueueStorageConfig(visibility_timeout_s=0, poison_max_attempts=3)
    worker = JobWorker(
        store=store, queue=queue, poison_queue=poison, config=config,
        is_cancelled=lambda job: fence["on"],
    )
    worker.process_once(max_messages=5)

    assert store.get("u1", jid).status is JobStatus.CANCELLED
    assert queue.depth() == 0
    assert poison.depth() == 0


def test_registry_rejects_duplicate():
    @job_handler("dup")
    def _a(job, *, heartbeat):
        return None

    with pytest.raises(ValueError):
        @job_handler("dup")
        def _b(job, *, heartbeat):
            return None
