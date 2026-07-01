"""master_plan_generation specialist — starts a new master-plan generation job.

This brings the existing async S1 generation flow under the orchestrator brain:
Resolver routes "帮我生成赛季总纲 / 重建 master plan" here, and this runner
starts or reuses the same background job as ``POST /master-plan/generate``.

The generated plan is still a DRAFT and still goes through the existing job
polling + review/confirm flow. No plan is activated inside the chat turn.
"""

from __future__ import annotations

import re

from coach.contracts import (
    ArtifactRef,
    SpecialistCard,
    SpecialistResult,
    SpecialistRunner,
    SpecialistTask,
)

from ..master_plan_generation_job import (
    MasterPlanGenerationJobError,
    start_master_plan_generation_job,
)


_GOAL_ID_RE = re.compile(r"\bgoal_id=([A-Za-z0-9_-]+)")


def _extract_goal_id(text: str) -> str | None:
    match = _GOAL_ID_RE.search(text)
    return match.group(1) if match else None


MASTER_PLAN_GENERATION_CARD = SpecialistCard(
    id="master_plan_generation",
    description=(
        "从当前训练目标和跑步档案生成新的长期赛季计划/训练总纲。适用于用户想新建、"
        "重新生成、重建、开始制定 master plan，而不是调整一个已存在的赛季计划。"
    ),
    tags=["生成", "新建", "重建", "赛季计划", "训练总纲", "master plan"],
    examples=[
        "帮我生成一个赛季计划",
        "重新生成我的训练总纲",
        "根据当前目标制定 master plan",
        "我要从零开始做一个马拉松备赛计划",
    ],
    writes=True,
    requires_target=False,
    data_needs=[],
)


def make_master_plan_generation_runner(*, user_id: str) -> SpecialistRunner:
    """Build the runner for async master-plan generation."""

    def _run(task: SpecialistTask) -> SpecialistResult:
        goal_id = _extract_goal_id(task.objective)
        try:
            result = start_master_plan_generation_job(user_id=user_id, goal_id=goal_id)
        except MasterPlanGenerationJobError as exc:
            if exc.code == "missing_goal":
                return SpecialistResult(
                    status="needs_clarification",
                    clarification="你还没有设置训练目标。先设置目标后，我就能为你生成赛季总纲。",
                )
            return SpecialistResult(
                status="failed",
                reply_fragment=f"暂时无法启动赛季总纲生成：{exc.message}",
            )

        if result.reused_existing:
            reply = (
                "你已经有一个赛季总纲生成任务在进行中，我会复用这个任务。\n\n"
                f"job_id: `{result.job_id}`\n"
                f"当前状态: `{result.status}`\n\n"
                "可以继续用现有的 master-plan job 状态接口轮询结果。"
            )
        else:
            reply = (
                "我已经开始为你生成新的赛季训练总纲。\n\n"
                f"job_id: `{result.job_id}`\n"
                f"当前状态: `{result.status}`\n"
                f"预计等待: 约 {result.eta_seconds} 秒\n\n"
                "生成完成后会得到一个草稿总纲，仍需要你 review 并确认后才会成为 active 计划。"
            )
        return SpecialistResult(
            status="completed",
            reply_fragment=reply,
            artifacts=[
                ArtifactRef(
                    id=result.job_id,
                    kind="master_plan_generation_job",
                    uri=f"/api/users/me/master-plan/jobs/{result.job_id}",
                    summary=result.status,
                )
            ],
        )

    return _run
