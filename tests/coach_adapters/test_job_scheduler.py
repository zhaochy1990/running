"""US-008 acceptance: JobScheduler (Pattern A from plan §8)."""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from coach.schemas import JobStage, JobStatus, JobType
from stride_server.coach_adapters.job_scheduler import (
    STALE_HEARTBEAT_SECONDS,
    JobScheduler,
    _now_iso,
)
from stride_server.coach_adapters.persistence.jobs_store import FileJobsStore


@pytest.fixture
def scheduler(tmp_path: Path):
    store = FileJobsStore(tmp_path)
    return JobScheduler(store), store


def test_create_writes_queued_row(scheduler):
    sched, store = scheduler
    jid = sched.create(
        user_id="u1",
        job_type=JobType.WEEKLY_PLAN_GENERATE,
        input_payload={"folder": "W01"},
    )
    job = store.get("u1", jid)
    assert job is not None
    assert job.status == JobStatus.QUEUED
    assert job.progress_pct == 0
    assert job.input_json is not None
    assert "folder" in job.input_json


def test_run_happy_path_flips_to_done(scheduler):
    sched, store = scheduler
    jid = sched.create(user_id="u1", job_type=JobType.WEEKLY_PLAN_GENERATE)

    def work(*, heartbeat):
        heartbeat(stage=JobStage.GENERATE, progress_pct=50)
        return {"plan": "ok"}

    sched.run(jid, work, user_id="u1")
    job = store.get("u1", jid)
    assert job.status == JobStatus.DONE
    assert job.progress_pct == 100
    assert job.completed_at is not None
    assert job.result_json is not None
    assert "ok" in job.result_json


def test_run_exception_flips_to_failed(scheduler):
    sched, store = scheduler
    jid = sched.create(user_id="u1", job_type=JobType.WEEKLY_PLAN_GENERATE)

    def boom(*, heartbeat):
        heartbeat(stage=JobStage.GENERATE)
        raise RuntimeError("kaboom")

    sched.run(jid, boom, user_id="u1")
    job = store.get("u1", jid)
    assert job.status == JobStatus.FAILED
    assert job.error_code == "RuntimeError"
    assert "kaboom" in (job.error_message or "")


def test_heartbeat_updates_stage_and_progress(scheduler):
    sched, store = scheduler
    jid = sched.create(user_id="u1", job_type=JobType.MASTER_PLAN_GENERATE)
    captured: list[tuple] = []

    def work(*, heartbeat):
        heartbeat(stage=JobStage.LOAD_CONTEXT, progress_pct=10)
        captured.append(("after_load_ctx", store.get("u1", jid)))
        heartbeat(stage=JobStage.DESIGN_PHASES, progress_pct=60)
        captured.append(("after_design", store.get("u1", jid)))
        return None

    sched.run(jid, work, user_id="u1")

    after_load_ctx = captured[0][1]
    after_design = captured[1][1]
    assert after_load_ctx.stage == JobStage.LOAD_CONTEXT
    assert after_load_ctx.progress_pct == 10
    assert after_design.stage == JobStage.DESIGN_PHASES
    assert after_design.progress_pct == 60


def test_reconcile_marks_stale_running_jobs_failed(scheduler):
    sched, store = scheduler
    # Stale RUNNING job (heartbeat older than threshold)
    stale_iso = (
        datetime.now(timezone.utc) - timedelta(seconds=STALE_HEARTBEAT_SECONDS + 30)
    ).isoformat().replace("+00:00", "Z")
    jid = sched.create(user_id="u1", job_type=JobType.WEEKLY_PLAN_GENERATE)
    store.update(jid, "u1", status=JobStatus.RUNNING, heartbeat_at=stale_iso)
    # Fresh RUNNING job (recent heartbeat) — should NOT be swept
    fresh_jid = sched.create(user_id="u1", job_type=JobType.WEEKLY_PLAN_GENERATE)
    store.update(fresh_jid, "u1", status=JobStatus.RUNNING, heartbeat_at=_now_iso())

    swept = sched.reconcile_stale_jobs()
    assert jid in swept
    assert fresh_jid not in swept

    job = store.get("u1", jid)
    assert job.status == JobStatus.FAILED
    assert job.error_code == "interrupted_by_restart"
    assert "restart" in (job.error_message or "")

    fresh = store.get("u1", fresh_jid)
    assert fresh.status == JobStatus.RUNNING


def test_reconcile_skips_done_jobs(scheduler):
    sched, store = scheduler
    jid = sched.create(user_id="u1", job_type=JobType.WEEKLY_PLAN_GENERATE)
    sched.run(jid, lambda *, heartbeat: None, user_id="u1")
    assert store.get("u1", jid).status == JobStatus.DONE
    swept = sched.reconcile_stale_jobs()
    assert jid not in swept
