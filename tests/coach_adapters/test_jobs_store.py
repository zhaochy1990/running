"""US-004 acceptance tests for FileJobsStore (Azure backend uses same interface)."""

from __future__ import annotations

from pathlib import Path

import pytest

from coach.schemas import CoachJob, JobStage, JobStatus, JobType
from stride_server.coach_adapters.persistence.jobs_store import FileJobsStore


def _make_job(user_id: str = "u1", job_id: str = "j1", status: JobStatus = JobStatus.QUEUED) -> CoachJob:
    return CoachJob(
        job_id=job_id,
        user_id=user_id,
        job_type=JobType.WEEKLY_PLAN_GENERATE,
        status=status,
        stage=None,
        progress_pct=0,
        heartbeat_at="2026-05-13T10:00:00Z",
        created_at="2026-05-13T10:00:00Z",
        updated_at="2026-05-13T10:00:00Z",
    )


def test_create_and_get(tmp_path: Path) -> None:
    store = FileJobsStore(tmp_path)
    j = _make_job()
    store.create(j)
    got = store.get("u1", "j1")
    assert got is not None
    assert got.job_id == "j1"
    assert got.status == JobStatus.QUEUED


def test_get_missing_returns_none(tmp_path: Path) -> None:
    store = FileJobsStore(tmp_path)
    assert store.get("nobody", "nothing") is None


def test_create_duplicate_raises(tmp_path: Path) -> None:
    store = FileJobsStore(tmp_path)
    store.create(_make_job())
    with pytest.raises(ValueError):
        store.create(_make_job())


def test_update_changes_fields(tmp_path: Path) -> None:
    store = FileJobsStore(tmp_path)
    store.create(_make_job())
    updated = store.update(
        "j1",
        "u1",
        status=JobStatus.RUNNING,
        stage=JobStage.GENERATE,
        progress_pct=42,
        heartbeat_at="2026-05-13T10:01:00Z",
    )
    assert updated.status == JobStatus.RUNNING
    assert updated.stage == JobStage.GENERATE
    assert updated.progress_pct == 42
    # And re-read from disk
    refetched = store.get("u1", "j1")
    assert refetched is not None
    assert refetched.status == JobStatus.RUNNING


def test_update_missing_raises(tmp_path: Path) -> None:
    store = FileJobsStore(tmp_path)
    with pytest.raises(KeyError):
        store.update("nope", "nobody", status=JobStatus.DONE)


def test_list_running_filters_correctly(tmp_path: Path) -> None:
    store = FileJobsStore(tmp_path)
    store.create(_make_job(job_id="j1", status=JobStatus.QUEUED))
    store.create(_make_job(user_id="u2", job_id="j2", status=JobStatus.RUNNING))
    store.create(_make_job(user_id="u3", job_id="j3", status=JobStatus.DONE))
    running = store.list_running()
    assert len(running) == 1
    assert running[0].job_id == "j2"


def test_list_by_user_isolation(tmp_path: Path) -> None:
    store = FileJobsStore(tmp_path)
    store.create(_make_job(user_id="alice", job_id="a1"))
    store.create(_make_job(user_id="alice", job_id="a2"))
    store.create(_make_job(user_id="bob", job_id="b1"))
    alice_jobs = store.list_by_user("alice")
    assert {j.job_id for j in alice_jobs} == {"a1", "a2"}
    assert store.list_by_user("bob") == [j for j in store.list_by_user("bob") if j.job_id == "b1"]


def test_delete_user_sweep(tmp_path: Path) -> None:
    store = FileJobsStore(tmp_path)
    for i in range(5):
        store.create(_make_job(user_id="doomed", job_id=f"d{i}"))
    store.create(_make_job(user_id="keeper", job_id="k1"))
    deleted = store.delete_user("doomed")
    assert deleted == 5
    assert store.list_by_user("doomed") == []
    # Other users unaffected
    assert len(store.list_by_user("keeper")) == 1
