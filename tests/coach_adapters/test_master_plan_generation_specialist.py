"""master_plan_generation specialist — orchestrator entry to S1 async gen."""

from __future__ import annotations

from coach.contracts import SpecialistTask
from stride_server.coach_adapters.master_plan_generation_job import (
    MasterPlanGenerationJobError,
    MasterPlanGenerationJobResult,
)
from stride_server.coach_adapters.orchestrator import master_plan_generation as mpg
from stride_server.coach_adapters.orchestrator.master_plan_generation import (
    MASTER_PLAN_GENERATION_CARD,
    make_master_plan_generation_runner,
)


def test_card_is_write_without_target_requirement() -> None:
    assert MASTER_PLAN_GENERATION_CARD.id == "master_plan_generation"
    assert MASTER_PLAN_GENERATION_CARD.writes is True
    assert MASTER_PLAN_GENERATION_CARD.requires_target is False
    assert any("生成" in ex for ex in MASTER_PLAN_GENERATION_CARD.examples)


def test_runner_starts_generation_job(monkeypatch) -> None:
    captured: dict[str, str] = {}

    def _fake_start(*, user_id: str, goal_id=None, profile_id=None):
        captured.update(user_id=user_id, goal_id=goal_id, profile_id=profile_id)
        return MasterPlanGenerationJobResult(job_id="job-1", status="queued")

    monkeypatch.setattr(mpg, "start_master_plan_generation_job", _fake_start)
    runner = make_master_plan_generation_runner(user_id="u1")
    result = runner(SpecialistTask(objective="帮我生成一个赛季计划 goal_id=goal-1"))
    assert result.status == "completed"
    assert result.proposal is None
    assert "job-1" in result.reply_fragment
    assert "草稿总纲" in result.reply_fragment
    assert captured == {"user_id": "u1", "goal_id": "goal-1", "profile_id": None}


def test_runner_reuses_existing_generation_job(monkeypatch) -> None:
    def _fake_start(**_kw):
        return MasterPlanGenerationJobResult(
            job_id="job-existing", status="running", reused_existing=True
        )

    monkeypatch.setattr(mpg, "start_master_plan_generation_job", _fake_start)
    result = make_master_plan_generation_runner(user_id="u1")(
        SpecialistTask(objective="重新生成训练总纲")
    )
    assert result.status == "completed"
    assert "复用" in result.reply_fragment
    assert "job-existing" in result.reply_fragment


def test_runner_missing_goal_asks_clarification(monkeypatch) -> None:
    def _fake_start(**_kw):
        raise MasterPlanGenerationJobError("missing_goal", "训练目标未设置")

    monkeypatch.setattr(mpg, "start_master_plan_generation_job", _fake_start)
    result = make_master_plan_generation_runner(user_id="u1")(
        SpecialistTask(objective="帮我生成一个赛季计划")
    )
    assert result.status == "needs_clarification"
    assert result.clarification
    assert "训练目标" in result.clarification
