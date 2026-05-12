"""Unit tests for job_runner module (T11)."""

from __future__ import annotations

import threading
import time

import pytest

from stride_server.job_runner import (
    Job,
    JobStatus,
    JobStage,
    _JOB_TTL_SECONDS,
    _JOBS,
    _reset_jobs_for_tests,
    create_job,
    get_job,
    get_running_job_for_user,
    update_job,
)

USER_A = "a1b2c3d4-e5f6-4aaa-89ab-111111111111"
USER_B = "b1b2c3d4-e5f6-4aaa-89ab-222222222222"

UUID4_RE = (
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


@pytest.fixture(autouse=True)
def reset_jobs():
    """Clear job store before each test."""
    _reset_jobs_for_tests()
    yield
    _reset_jobs_for_tests()


# ---------------------------------------------------------------------------
# Test 1: create_job returns uuid and status=QUEUED
# ---------------------------------------------------------------------------


def test_create_job_returns_uuid_and_queued_status():
    import re
    job_id = create_job(USER_A)
    assert re.match(UUID4_RE, job_id), f"Expected UUID4, got: {job_id}"

    job = get_job(job_id)
    assert job is not None
    assert job.status == JobStatus.QUEUED
    assert job.progress == 0
    assert job.stage is None
    assert job.result_plan_id is None
    assert job.error is None
    assert job.raw_output is None
    assert job.user_id == USER_A
    assert job.created_at_iso  # non-empty ISO string


# ---------------------------------------------------------------------------
# Test 2: update_job modifies fields and updates updated_at
# ---------------------------------------------------------------------------


def test_update_job_modifies_fields_and_updates_timestamp():
    job_id = create_job(USER_A)
    job_before = get_job(job_id)
    old_updated_at = job_before.updated_at

    # small sleep so monotonic advances
    time.sleep(0.01)

    update_job(
        job_id,
        status=JobStatus.RUNNING,
        stage=JobStage.EVALUATING,
        progress=30,
    )

    job = get_job(job_id)
    assert job.status == JobStatus.RUNNING
    assert job.stage == JobStage.EVALUATING
    assert job.progress == 30
    assert job.updated_at > old_updated_at


# ---------------------------------------------------------------------------
# Test 3: get_job returns None for expired job (mock time.monotonic)
# ---------------------------------------------------------------------------


def test_get_job_returns_none_for_expired_job(monkeypatch):
    job_id = create_job(USER_A)

    # Advance monotonic clock past TTL
    real_monotonic = time.monotonic

    def fast_monotonic():
        return real_monotonic() + _JOB_TTL_SECONDS + 1

    import stride_server.job_runner as jr_mod
    monkeypatch.setattr(jr_mod.time, "monotonic", fast_monotonic)

    result = get_job(job_id)
    assert result is None


# ---------------------------------------------------------------------------
# Test 4: multi-thread update has no data races
# ---------------------------------------------------------------------------


def test_concurrent_updates_no_data_race():
    """10 threads each update progress 100 times; final value must be consistent."""
    job_id = create_job(USER_A)
    results = []
    errors = []

    def worker(thread_idx: int):
        for i in range(100):
            try:
                update_job(job_id, progress=(thread_idx * 100 + i) % 101)
            except Exception as exc:
                errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"Errors during concurrent updates: {errors}"

    job = get_job(job_id)
    assert job is not None
    # progress must be a valid 0-100 value (some thread's last write)
    assert 0 <= job.progress <= 100


# ---------------------------------------------------------------------------
# Test 5: get_running_job_for_user returns active job, not done job
# ---------------------------------------------------------------------------


def test_get_running_job_for_user_returns_active_only():
    # Create active (QUEUED) job
    active_id = create_job(USER_A)

    # Create done job for same user
    done_id = create_job(USER_A)
    update_job(done_id, status=JobStatus.DONE, progress=100)

    found = get_running_job_for_user(USER_A)
    assert found is not None
    assert found.job_id == active_id
    assert found.status == JobStatus.QUEUED


def test_get_running_job_for_user_returns_none_when_all_done():
    job_id = create_job(USER_A)
    update_job(job_id, status=JobStatus.DONE, progress=100)

    found = get_running_job_for_user(USER_A)
    assert found is None


def test_get_running_job_for_user_isolates_by_user():
    """User A's job must not be returned when querying User B."""
    create_job(USER_A)  # active for A

    found = get_running_job_for_user(USER_B)
    assert found is None


# ---------------------------------------------------------------------------
# Test 6: update_job with unknown field raises AttributeError
# ---------------------------------------------------------------------------


def test_update_job_unknown_field_raises():
    job_id = create_job(USER_A)
    with pytest.raises(AttributeError):
        update_job(job_id, nonexistent_field="bad")


# ---------------------------------------------------------------------------
# Test 7: STAGE_PROGRESS_MAP and STAGE_LABEL_MAP completeness
# ---------------------------------------------------------------------------


def test_stage_maps_cover_all_stages():
    from stride_server.job_runner import STAGE_LABEL_MAP, STAGE_PROGRESS_MAP

    for stage in JobStage:
        assert stage in STAGE_PROGRESS_MAP, f"Missing progress for {stage}"
        assert stage in STAGE_LABEL_MAP, f"Missing label for {stage}"
        assert isinstance(STAGE_LABEL_MAP[stage], str) and STAGE_LABEL_MAP[stage]
        assert 0 <= STAGE_PROGRESS_MAP[stage] <= 100
