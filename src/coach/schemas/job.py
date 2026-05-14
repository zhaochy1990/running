"""Job tracking schema for the stridecoachjobs Azure Table — see plan §4.1, §8.

Pattern A: every long-running operation gets a CoachJob row with heartbeats so
the startup reconcile hook can detect ACA restarts mid-execution and mark
abandoned jobs as failed.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class JobType(str, Enum):
    MASTER_PLAN_GENERATE = "master_plan_generate"
    WEEKLY_PLAN_GENERATE = "weekly_plan_generate"
    WEEKLY_REVIEW = "weekly_review"
    ACTIVITY_COMMENTARY = "activity_commentary"


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class JobStage(str, Enum):
    LOAD_CONTEXT = "load_context"
    EVALUATE_FITNESS = "evaluate_fitness"
    DESIGN_PHASES = "design_phases"
    GENERATE = "generate"
    RULE_FILTER = "rule_filter"
    REVIEW = "review"
    APPLY_PATCHES = "apply_patches"
    FINALIZE = "finalize"
    INSIGHTS = "insights"
    NEXT_WEEK_PREVIEW = "next_week_preview"


class CoachJob(BaseModel):
    """A single job row from ``stridecoachjobs`` (PartitionKey=user_id,
    RowKey=job_id). Field order matches the Azure Table schema in plan §4.1."""

    job_id: str
    user_id: str
    job_type: JobType
    status: JobStatus
    stage: JobStage | None = None
    progress_pct: int = Field(default=0, ge=0, le=100)
    heartbeat_at: str
    input_json: str | None = None
    result_json: str | None = None
    review_report_json: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    created_at: str
    updated_at: str
    completed_at: str | None = None
