"""Master-scope draft tools emit valid MasterPlanDiff values."""

from __future__ import annotations

from datetime import date, datetime, timezone
from uuid import uuid4

import pytest

from coach.schemas import ToolResult
from coach.graphs.conversation.master_diff_gate import validate_master_diff
from stride_core.master_plan import (
    MasterPlan,
    MasterPlanGoal,
    MasterPlanStatus,
    Milestone,
    MilestoneType,
    Phase,
    PhaseType,
)
from stride_core.master_plan_diff import MasterPlanDiff, MasterPlanDiffOpKind
from stride_server.coach_adapters.tool_impls import draft_impls


USER_ID = "test-user-uuid"


# ---------------------------------------------------------------------------
# Fixture: in-memory MasterPlanStore seeded with one active plan
# ---------------------------------------------------------------------------


@pytest.fixture
def seeded_plan(tmp_path, monkeypatch):
    """Wire FileMasterPlanStore to tmp_path, seed one MasterPlan, return it."""
    import stride_core.db as core_db_mod

    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setenv("STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL", "")

    from stride_server.master_plan_store import reset_master_plan_store_cache

    reset_master_plan_store_cache()

    phase1 = Phase(
        id=str(uuid4()),
        name="基础期",
        start_date="2026-05-12",
        end_date="2026-07-06",
        focus="有氧基础",
        weekly_distance_km_low=40.0,
        weekly_distance_km_high=50.0,
        key_session_types=["长距离"],
        milestone_ids=[],
    )
    phase2 = Phase(
        id=str(uuid4()),
        name="强化期",
        start_date="2026-07-07",
        end_date="2026-09-14",
        focus="阈值+间歇",
        weekly_distance_km_low=50.0,
        weekly_distance_km_high=65.0,
        key_session_types=["阈值跑"],
        milestone_ids=[],
    )
    milestone = Milestone(
        id=str(uuid4()),
        type=MilestoneType.TEST_RUN,
        date="2026-08-15",
        phase_id=phase2.id,
        target="20K 测试 4'30/km",
        completed_actual=None,
    )
    now = datetime.now(timezone.utc).isoformat()
    plan = MasterPlan(
        plan_id=str(uuid4()),
        user_id=USER_ID,
        status=MasterPlanStatus.ACTIVE,
        goal=MasterPlanGoal(goal_id=str(uuid4()), target_time="", race_date="2026-09-14"),
        start_date="2026-05-12",
        end_date="2026-09-14",
        phases=[phase1, phase2],
        milestones=[milestone],
        training_principles=["渐进", "充足恢复"],
        generated_by="gpt-4.1",
        version=1,
        created_at=now,
        updated_at=now,
    )
    from stride_server.master_plan_store import get_master_plan_store

    get_master_plan_store().save_plan(plan)
    yield plan, phase1, phase2, milestone
    reset_master_plan_store_cache()


def _assert_master_diff(res: ToolResult) -> MasterPlanDiff:
    assert res.ok, f"tool failed: {res.errors}"
    assert isinstance(res.data, dict)
    return MasterPlanDiff.model_validate(res.data)


# ---------------------------------------------------------------------------
# extend_phase / compress_phase
# ---------------------------------------------------------------------------


def test_extend_phase_shifts_end_date_forward(seeded_plan):
    plan, phase1, _, _ = seeded_plan
    res = draft_impls.ExtendPhaseImpl(USER_ID)(
        plan_id=plan.plan_id, phase_id=phase1.id, weeks=2
    )
    diff = _assert_master_diff(res)
    assert len(diff.ops) == 1
    op = diff.ops[0]
    assert op.op == MasterPlanDiffOpKind.RESIZE_PHASE
    assert op.phase_id == phase1.id
    assert op.spec_patch["end_date"] == "2026-07-20"  # 2026-07-06 + 2 weeks


def test_extend_phase_zero_weeks_fails(seeded_plan):
    plan, phase1, _, _ = seeded_plan
    res = draft_impls.ExtendPhaseImpl(USER_ID)(
        plan_id=plan.plan_id, phase_id=phase1.id, weeks=0
    )
    assert not res.ok


def test_extend_phase_missing_plan_fails(seeded_plan):
    plan, phase1, _, _ = seeded_plan
    res = draft_impls.ExtendPhaseImpl(USER_ID)(
        plan_id="nonexistent", phase_id=phase1.id, weeks=2
    )
    assert not res.ok
    assert any("not found" in e for e in res.errors)


def test_extend_phase_missing_phase_fails(seeded_plan):
    plan, _, _, _ = seeded_plan
    res = draft_impls.ExtendPhaseImpl(USER_ID)(
        plan_id=plan.plan_id, phase_id="bogus", weeks=2
    )
    assert not res.ok


def test_compress_phase_shifts_end_date_backward(seeded_plan):
    plan, phase1, _, _ = seeded_plan
    res = draft_impls.CompressPhaseImpl(USER_ID)(
        plan_id=plan.plan_id, phase_id=phase1.id, weeks=2
    )
    diff = _assert_master_diff(res)
    assert len(diff.ops) == 1
    assert diff.ops[0].spec_patch["end_date"] == "2026-06-22"  # 2026-07-06 - 2 weeks


def test_compress_phase_below_start_fails(seeded_plan):
    plan, phase1, _, _ = seeded_plan
    res = draft_impls.CompressPhaseImpl(USER_ID)(
        plan_id=plan.plan_id, phase_id=phase1.id, weeks=100
    )
    assert not res.ok


def test_compress_phase_refuses_to_shorten_final_two_week_taper(seeded_plan):
    plan, phase1, phase2, _ = seeded_plan
    from stride_server.master_plan_store import get_master_plan_store

    taper = phase2.model_copy(
        update={
            "name": "调整期",
            "start_date": "2026-09-01",
            "end_date": "2026-09-14",
        }
    )
    get_master_plan_store().save_plan(
        plan.model_copy(update={"phases": [phase1, taper]})
    )

    res = draft_impls.CompressPhaseImpl(USER_ID)(
        plan_id=plan.plan_id, phase_id=taper.id, weeks=1
    )

    assert not res.ok
    assert "必须完整保留" in res.errors[0]


def test_compress_phase_allows_short_final_recovery(seeded_plan):
    plan, phase1, phase2, _ = seeded_plan
    from stride_server.master_plan_store import get_master_plan_store

    recovery = phase2.model_copy(
        update={
            "name": "调整恢复期",
            "focus": "主动恢复",
            "phase_type": PhaseType.RECOVERY,
            "start_date": "2026-09-01",
            "end_date": "2026-09-14",
        }
    )
    get_master_plan_store().save_plan(
        plan.model_copy(update={"phases": [phase1, recovery]})
    )

    res = draft_impls.CompressPhaseImpl(USER_ID)(
        plan_id=plan.plan_id, phase_id=recovery.id, weeks=1
    )

    assert res.ok
    diff = MasterPlanDiff.model_validate(res.data)
    assert diff.ops[0].spec_patch["end_date"] == "2026-09-07"


# ---------------------------------------------------------------------------
# shift_milestone / change_target
# ---------------------------------------------------------------------------


def test_shift_milestone_changes_date(seeded_plan):
    plan, _, _, milestone = seeded_plan
    res = draft_impls.ShiftMilestoneImpl(USER_ID)(
        plan_id=plan.plan_id, milestone_id=milestone.id, new_date="2026-08-22"
    )
    diff = _assert_master_diff(res)
    assert len(diff.ops) == 1
    op = diff.ops[0]
    assert op.op == MasterPlanDiffOpKind.REPLACE_MILESTONE_DATE
    assert op.milestone_id == milestone.id
    assert op.spec_patch["date"] == "2026-08-22"


def test_shift_milestone_bad_date_fails(seeded_plan):
    plan, _, _, milestone = seeded_plan
    res = draft_impls.ShiftMilestoneImpl(USER_ID)(
        plan_id=plan.plan_id, milestone_id=milestone.id, new_date="not-a-date"
    )
    assert not res.ok


def test_change_target_replaces_target(seeded_plan):
    plan, _, _, milestone = seeded_plan
    res = draft_impls.ChangeTargetImpl(USER_ID)(
        plan_id=plan.plan_id,
        milestone_id=milestone.id,
        new_target_time="20K 测试 4'15/km",
    )
    diff = _assert_master_diff(res)
    assert len(diff.ops) == 1
    op = diff.ops[0]
    assert op.op == MasterPlanDiffOpKind.REPLACE_MILESTONE_TARGET
    assert op.spec_patch["target"] == "20K 测试 4'15/km"


def test_change_target_empty_fails(seeded_plan):
    plan, _, _, milestone = seeded_plan
    res = draft_impls.ChangeTargetImpl(USER_ID)(
        plan_id=plan.plan_id, milestone_id=milestone.id, new_target_time=""
    )
    assert not res.ok


# ---------------------------------------------------------------------------
# propose_alternatives
# ---------------------------------------------------------------------------


def test_set_phase_weekly_range_returns_exact_typed_diff(seeded_plan, monkeypatch):
    plan, phase1, _, _ = seeded_plan
    tool = draft_impls.SetPhaseWeeklyRangeImpl(
        plan.user_id, plan_loader=lambda plan_id: plan if plan_id == plan.plan_id else None
    )

    result = tool(
        plan_id=plan.plan_id,
        phase_id=phase1.id,
        weekly_distance_km_low=55,
        weekly_distance_km_high=65,
        reason="用户明确要求且训练负荷支持",
    )

    assert result.ok is True
    diff = MasterPlanDiff.model_validate(result.data)
    assert len(diff.ops) == 1
    op = diff.ops[0]
    assert op.op == MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE
    assert op.phase_id == phase1.id
    assert op.old_value == {
        "weekly_distance_km_low": phase1.weekly_distance_km_low,
        "weekly_distance_km_high": phase1.weekly_distance_km_high,
    }
    assert op.new_value == {
        "weekly_distance_km_low": 55.0,
        "weekly_distance_km_high": 65.0,
    }


def test_set_phase_weekly_range_rejects_inverted_range(seeded_plan):
    plan, phase1, _, _ = seeded_plan
    tool = draft_impls.SetPhaseWeeklyRangeImpl(
        plan.user_id, plan_loader=lambda _plan_id: plan
    )

    result = tool(
        plan_id=plan.plan_id,
        phase_id=phase1.id,
        weekly_distance_km_low=70,
        weekly_distance_km_high=60,
        reason="bad input",
    )

    assert result.ok is False
    assert "low <= high" in result.errors[0]


@pytest.mark.parametrize("low,high", [(float("nan"), 60), (50, float("inf"))])
def test_set_phase_weekly_range_rejects_non_finite_values(
    seeded_plan, low: float, high: float
):
    plan, phase1, _, _ = seeded_plan
    tool = draft_impls.SetPhaseWeeklyRangeImpl(
        plan.user_id, plan_loader=lambda _plan_id: plan
    )

    result = tool(
        plan_id=plan.plan_id,
        phase_id=phase1.id,
        weekly_distance_km_low=low,
        weekly_distance_km_high=high,
        reason="bad input",
    )

    assert result.ok is False
    assert "finite" in result.errors[0]


def test_set_phase_weekly_range_rejects_noop(seeded_plan):
    plan, phase1, _, _ = seeded_plan
    tool = draft_impls.SetPhaseWeeklyRangeImpl(
        plan.user_id, plan_loader=lambda _plan_id: plan
    )

    result = tool(
        plan_id=plan.plan_id,
        phase_id=phase1.id,
        weekly_distance_km_low=phase1.weekly_distance_km_low,
        weekly_distance_km_high=phase1.weekly_distance_km_high,
        reason="same range",
    )

    assert result.ok is False
    assert "no proposal is needed" in result.errors[0]


def test_propose_alternatives_returns_two_diffs(seeded_plan, monkeypatch):
    plan, phase1, phase2, _ = seeded_plan
    monkeypatch.setattr(
        draft_impls, "today_shanghai", lambda: date(2026, 7, 15)
    )
    res = draft_impls.ProposeAlternativesImpl(USER_ID)(
        plan_id=plan.plan_id, intent="想加大强度但又怕受伤"
    )
    assert res.ok
    assert "alternatives" in res.data
    alts = res.data["alternatives"]
    assert len(alts) == 2
    # Each alternative validates as a MasterPlanDiff
    for alt in alts:
        diff = MasterPlanDiff.model_validate(alt)
        assert len(diff.ops) == 1
        assert diff.ops[0].op == MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE
        assert diff.ops[0].phase_id == phase2.id
        assert validate_master_diff(plan, diff) == []
    # The two alternatives must differ (保守 vs 激进)
    assert (
        alts[0]["ops"][0]["spec_patch"]["weekly_distance_km_high"]
        != alts[1]["ops"][0]["spec_patch"]["weekly_distance_km_high"]
    )
    assert phase2.start_date == "2026-07-07"
    assert phase2.end_date == "2026-09-14"


def test_propose_alternatives_targets_current_phase_before_future_phases(
    seeded_plan, monkeypatch
):
    plan, phase1, phase2, _ = seeded_plan
    from stride_server.master_plan_store import get_master_plan_store

    monkeypatch.setattr(
        draft_impls, "today_shanghai", lambda: date(2026, 7, 15)
    )
    current = phase2.model_copy(
        update={"end_date": "2026-07-31", "name": "昆明高原训练期"}
    )
    future = phase2.model_copy(
        update={
            "id": "future-peak",
            "name": "未来专项期",
            "start_date": "2026-08-01",
            "end_date": "2026-08-31",
        }
    )
    taper = phase2.model_copy(
        update={
            "id": "taper",
            "name": "调整期",
            "start_date": "2026-09-01",
            "end_date": "2026-09-14",
        }
    )
    get_master_plan_store().save_plan(
        plan.model_copy(update={"phases": [phase1, current, future, taper]})
    )

    res = draft_impls.ProposeAlternativesImpl(USER_ID)(
        plan_id=plan.plan_id, intent="我在昆明高原待到 7 月 26 日，调整当前阶段周跑量"
    )

    assert res.ok
    assert all(
        alt["ops"][0]["phase_id"] == current.id
        for alt in res.data["alternatives"]
    )
    assert all(
        "昆明高原训练期" in alt["ai_explanation"]
        for alt in res.data["alternatives"]
    )


def test_propose_alternatives_targets_build_before_short_taper(
    seeded_plan, monkeypatch
):
    plan, phase1, phase2, _ = seeded_plan
    from stride_server.master_plan_store import get_master_plan_store

    monkeypatch.setattr(
        draft_impls, "today_shanghai", lambda: date(2026, 6, 15)
    )

    taper = phase2.model_copy(
        update={
            "name": "调整期",
            "start_date": "2026-09-01",
            "end_date": "2026-09-14",
        }
    )
    short_taper_plan = plan.model_copy(update={"phases": [phase1, taper]})
    get_master_plan_store().save_plan(short_taper_plan)

    res = draft_impls.ProposeAlternativesImpl(USER_ID)(
        plan_id=plan.plan_id, intent="降低训练量"
    )

    assert res.ok
    for alt in res.data["alternatives"]:
        diff = MasterPlanDiff.model_validate(alt)
        assert diff.ops[0].phase_id == phase1.id
        assert "保留最后的调整期不变" in diff.ai_explanation
        assert validate_master_diff(short_taper_plan, diff) == []
    assert taper.start_date == "2026-09-01"
    assert taper.end_date == "2026-09-14"


def test_propose_alternatives_does_not_treat_short_recovery_as_taper(
    seeded_plan, monkeypatch
):
    plan, phase1, phase2, _ = seeded_plan
    from stride_server.master_plan_store import get_master_plan_store

    monkeypatch.setattr(
        draft_impls, "today_shanghai", lambda: date(2026, 9, 10)
    )
    recovery = phase2.model_copy(
        update={
            "name": "调整恢复期",
            "focus": "主动恢复",
            "phase_type": PhaseType.RECOVERY,
            "start_date": "2026-09-08",
            "end_date": "2026-09-14",
        }
    )
    get_master_plan_store().save_plan(
        plan.model_copy(update={"phases": [phase1, recovery]})
    )

    res = draft_impls.ProposeAlternativesImpl(USER_ID)(
        plan_id=plan.plan_id, intent="降低当前恢复期周跑量"
    )

    assert res.ok
    assert all(
        alt["ops"][0]["phase_id"] == recovery.id
        for alt in res.data["alternatives"]
    )
    assert all(
        "保留最后的调整期" not in alt["ai_explanation"]
        for alt in res.data["alternatives"]
    )


def test_propose_alternatives_refuses_when_only_final_taper_exists(seeded_plan):
    plan, _, phase2, _ = seeded_plan
    from stride_server.master_plan_store import get_master_plan_store

    taper_only = plan.model_copy(
        update={
            "phases": [
                phase2.model_copy(
                    update={
                        "name": "调整期",
                        "start_date": "2026-09-08",
                        "end_date": "2026-09-14",
                    }
                )
            ]
        }
    )
    get_master_plan_store().save_plan(taper_only)

    res = draft_impls.ProposeAlternativesImpl(USER_ID)(
        plan_id=plan.plan_id, intent="再少练一周"
    )

    assert not res.ok
    assert "保护最后 1–2 周" in res.errors[0]
    assert "无法生成" in res.errors[0]


def test_propose_alternatives_ignores_completed_phase_before_taper(
    seeded_plan, monkeypatch
):
    plan, phase1, phase2, _ = seeded_plan
    from stride_server.master_plan_store import get_master_plan_store

    monkeypatch.setattr(
        draft_impls, "today_shanghai", lambda: date(2026, 6, 15)
    )

    completed = phase1.model_copy(update={"is_completed": True})
    taper = phase2.model_copy(
        update={
            "name": "调整期",
            "start_date": "2026-09-01",
            "end_date": "2026-09-14",
        }
    )
    get_master_plan_store().save_plan(
        plan.model_copy(update={"phases": [completed, taper]})
    )

    res = draft_impls.ProposeAlternativesImpl(USER_ID)(
        plan_id=plan.plan_id, intent="降低接下来的训练量"
    )

    assert not res.ok
    assert "没有可安全降低周跑量的当前或后续阶段" in res.errors[0]


def test_propose_alternatives_can_reduce_single_long_phase(
    seeded_plan, monkeypatch
):
    plan, phase1, _, _ = seeded_plan
    from stride_server.master_plan_store import get_master_plan_store

    monkeypatch.setattr(
        draft_impls, "today_shanghai", lambda: date(2026, 6, 15)
    )

    single_phase = plan.model_copy(
        update={"phases": [phase1], "end_date": phase1.end_date}
    )
    get_master_plan_store().save_plan(single_phase)

    res = draft_impls.ProposeAlternativesImpl(USER_ID)(
        plan_id=plan.plan_id, intent="降低训练量"
    )

    assert res.ok
    assert len(res.data["alternatives"]) == 2
    assert all(
        alt["ops"][0]["phase_id"] == phase1.id
        for alt in res.data["alternatives"]
    )


# ---------------------------------------------------------------------------
# regenerate_master
# ---------------------------------------------------------------------------


def test_regenerate_master_emits_remove_ops_for_each_entity(seeded_plan):
    plan, _, _, _ = seeded_plan
    res = draft_impls.RegenerateMasterImpl(USER_ID)(
        plan_id=plan.plan_id, reason="目标变了"
    )
    diff = _assert_master_diff(res)
    # 2 phases + 1 milestone → 3 REMOVE ops
    op_kinds = sorted(o.op.value for o in diff.ops)
    assert op_kinds == sorted(["remove_phase", "remove_phase", "remove_milestone"])
    assert "目标变了" in diff.ai_explanation


def test_regenerate_master_missing_plan_fails(seeded_plan):
    res = draft_impls.RegenerateMasterImpl(USER_ID)(
        plan_id="nope", reason="x"
    )
    assert not res.ok
