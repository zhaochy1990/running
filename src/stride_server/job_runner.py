"""Async job runner for long-running LLM generation tasks (T11).

Provides a simple in-memory job registry with TTL-based expiry.
Jobs are identified by UUID and scoped to a user_id.

Thread-safety: all mutations go through _LOCK.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional
from uuid import uuid4
import time

# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class JobStage(str, Enum):
    READING_HISTORY  = "reading_history"
    EVALUATING       = "evaluating"
    PLANNING_PHASES  = "planning_phases"
    OUTPUTTING       = "outputting"


class JobStatus(str, Enum):
    QUEUED  = "queued"
    RUNNING = "running"
    DONE    = "done"
    FAILED  = "failed"


# ---------------------------------------------------------------------------
# Stage metadata
# ---------------------------------------------------------------------------

STAGE_PROGRESS_MAP: dict[JobStage, int] = {
    JobStage.READING_HISTORY:  10,
    JobStage.EVALUATING:       30,
    JobStage.PLANNING_PHASES:  60,
    JobStage.OUTPUTTING:       85,
}

STAGE_LABEL_MAP: dict[JobStage, str] = {
    JobStage.READING_HISTORY:  "正在读取历史训练数据…",
    JobStage.EVALUATING:       "评估当前体能水平…",
    JobStage.PLANNING_PHASES:  "结合目标规划训练阶段…",
    JobStage.OUTPUTTING:       "输出训练总纲…",
}

# ---------------------------------------------------------------------------
# Job dataclass
# ---------------------------------------------------------------------------


@dataclass
class Job:
    job_id: str
    user_id: str
    status: JobStatus
    stage: Optional[JobStage]
    progress: int                   # 0-100
    result_plan_id: Optional[str]
    error: Optional[str]
    raw_output: Optional[str]       # 解析失败时保留 LLM 原始输出
    created_at: float               # time.monotonic() — for elapsed calculation
    updated_at: float               # time.monotonic()
    created_at_iso: str             # datetime.now(UTC).isoformat() — for response


# ---------------------------------------------------------------------------
# Module-level store
# ---------------------------------------------------------------------------

_JOBS: dict[str, Job] = {}
_LOCK = threading.Lock()
_JOB_TTL_SECONDS = 3600  # 1 hour


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def create_job(user_id: str) -> str:
    """Create a new job for user_id, return the job_id (uuid4 string)."""
    job_id = str(uuid4())
    now = time.monotonic()
    job = Job(
        job_id=job_id,
        user_id=user_id,
        status=JobStatus.QUEUED,
        stage=None,
        progress=0,
        result_plan_id=None,
        error=None,
        raw_output=None,
        created_at=now,
        updated_at=now,
        created_at_iso=datetime.now(timezone.utc).isoformat(),
    )
    with _LOCK:
        _JOBS[job_id] = job
    return job_id


def get_job(job_id: str) -> Optional[Job]:
    """Return the Job for job_id, or None if not found or expired.

    Always runs cleanup_expired() first.
    """
    cleanup_expired()
    with _LOCK:
        return _JOBS.get(job_id)


def update_job(job_id: str, **kwargs) -> None:
    """Thread-safe update of any Job fields by keyword argument."""
    with _LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            return
        for key, value in kwargs.items():
            if hasattr(job, key):
                object.__setattr__(job, key, value)
            else:
                raise AttributeError(f"Job has no field {key!r}")
        object.__setattr__(job, "updated_at", time.monotonic())


def cleanup_expired() -> None:
    """Remove jobs older than _JOB_TTL_SECONDS from the store."""
    now = time.monotonic()
    with _LOCK:
        expired = [
            job_id
            for job_id, job in _JOBS.items()
            if now - job.created_at > _JOB_TTL_SECONDS
        ]
        for job_id in expired:
            del _JOBS[job_id]


def get_running_job_for_user(user_id: str) -> Optional[Job]:
    """Return the first QUEUED or RUNNING job for user_id, or None.

    Used for idempotency check — if a job is already in flight, return it
    instead of creating a duplicate.
    """
    cleanup_expired()
    with _LOCK:
        for job in _JOBS.values():
            if job.user_id == user_id and job.status in (JobStatus.QUEUED, JobStatus.RUNNING):
                return job
    return None


def _reset_jobs_for_tests() -> None:
    """Test hook — clear all jobs from the in-memory store."""
    with _LOCK:
        _JOBS.clear()
