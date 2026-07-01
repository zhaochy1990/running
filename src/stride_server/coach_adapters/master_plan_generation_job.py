"""Shared adapter for starting async master-plan generation jobs.

Both the legacy ``POST /master-plan/generate`` endpoint and the orchestrator
``master_plan_generation`` specialist use this module, so idempotency, goal
validation, and background-thread launch stay single-sourced.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Literal

from .. import job_runner, master_plan_generator
from ..content_store import read_json


@dataclass(frozen=True)
class MasterPlanGenerationJobResult:
    job_id: str
    status: str
    eta_seconds: int = 120
    reused_existing: bool = False


ErrorCode = Literal["goal_not_found", "missing_goal"]


class MasterPlanGenerationJobError(RuntimeError):
    """Domain error for job-start preconditions."""

    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def read_current_goal(user_id: str) -> dict[str, Any] | None:
    """Read the current training goal from the content store."""
    item = read_json(f"{user_id}/training_goal.json")
    if item is None:
        return None
    data, _ = item
    if isinstance(data, dict):
        current = data.get("current")
        return current if isinstance(current, dict) else None
    return None


def read_current_profile(user_id: str) -> dict[str, Any] | None:
    """Read the current running profile from the content store."""
    item = read_json(f"{user_id}/running_profile.json")
    if item is None:
        return None
    data, _ = item
    if isinstance(data, dict):
        current = data.get("current")
        return current if isinstance(current, dict) else None
    return None


def start_master_plan_generation_job(
    *,
    user_id: str,
    goal_id: str | None = None,
    profile_id: str | None = None,
) -> MasterPlanGenerationJobResult:
    """Start or reuse the async master-plan generation job for ``user_id``.

    ``profile_id`` is accepted for parity with the existing HTTP request shape;
    the current implementation still uses the user's current running profile,
    matching the legacy endpoint behavior.
    """
    del profile_id  # preserved in the public signature for future selection.

    existing = job_runner.get_running_job_for_user(user_id)
    if existing is not None:
        return MasterPlanGenerationJobResult(
            job_id=existing.job_id,
            status=existing.status.value,
            reused_existing=True,
        )

    if goal_id is not None:
        current_goal = read_current_goal(user_id)
        if current_goal is None or current_goal.get("goal_id") != goal_id:
            raise MasterPlanGenerationJobError(
                "goal_not_found", f"Training goal {goal_id!r} not found"
            )

    goal = read_current_goal(user_id)
    if goal is None:
        raise MasterPlanGenerationJobError("missing_goal", "训练目标未设置")

    profile = read_current_profile(user_id)
    job_id = job_runner.create_job(user_id)
    thread = threading.Thread(
        target=master_plan_generator.run_generate_job,
        args=(job_id, user_id, goal, profile),
        daemon=True,
        name=f"master-plan-gen-{job_id}",
    )
    thread.start()

    return MasterPlanGenerationJobResult(
        job_id=job_id,
        status=job_runner.JobStatus.QUEUED.value,
        reused_existing=False,
    )
