"""A3 — deterministic validation gate for MasterPlanDiff (spec Q#6)."""

from __future__ import annotations

import uuid

from coach.graphs.conversation.master_diff_gate import validate_master_diff
from stride_core.master_plan import (
    MasterPlan,
    MasterPlanStatus,
    Milestone,
    MilestoneType,
    Phase,
)
from stride_core.master_plan_diff import (
    MasterPlanDiff,
    MasterPlanDiffOp,
    MasterPlanDiffOpKind,
)

_TS = "2026-05-12T08:00:00+00:00"


def _phase() -> Phase:
    return Phase(
        id="phase-1",
        name="基础期",
        start_date="2026-06-01",
        end_date="2026-07-31",
        focus="基础有氧",
        weekly_distance_km_low=50.0,
        weekly_distance_km_high=65.0,
        key_session_types=["有氧"],
        milestone_ids=["ms-1"],
    )


def _milestone() -> Milestone:
    return Milestone(
        id="ms-1",
        type=MilestoneType.LONG_RUN,
        date="2026-07-20",
        phase_id="phase-1",
        target="30K 节奏跑",
    )


def _plan() -> MasterPlan:
    return MasterPlan(
        plan_id="plan-test",
        user_id="user-001",
        status=MasterPlanStatus.ACTIVE,
        goal_id="goal-1",
        start_date="2026-06-01",
        end_date="2026-11-15",
        phases=[_phase()],
        milestones=[_milestone()],
        training_principles=["循序渐进"],
        generated_by="gpt-4.1",
        version=1,
        created_at=_TS,
        updated_at=_TS,
    )


def _diff(*ops: MasterPlanDiffOp) -> MasterPlanDiff:
    return MasterPlanDiff(
        diff_id=str(uuid.uuid4()),
        plan_id="plan-test",
        ops=list(ops),
        ai_explanation="x",
        created_at=_TS,
    )


def _op(kind, **kw) -> MasterPlanDiffOp:
    base = dict(id=str(uuid.uuid4()), op=kind)
    base.update(kw)
    return MasterPlanDiffOp(**base)


def test_valid_resize_passes() -> None:
    op = _op(
        MasterPlanDiffOpKind.RESIZE_PHASE,
        phase_id="phase-1",
        spec_patch={"end_date": "2026-08-15"},  # extends, stays after start
    )
    assert validate_master_diff(_plan(), _diff(op)) == []


def test_resize_inverting_phase_is_rejected() -> None:
    op = _op(
        MasterPlanDiffOpKind.RESIZE_PHASE,
        phase_id="phase-1",
        spec_patch={"end_date": "2026-05-15"},  # before the 06-01 start
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "不早于" in violations[0]


def test_resize_unknown_phase_is_rejected() -> None:
    op = _op(
        MasterPlanDiffOpKind.RESIZE_PHASE,
        phase_id="ghost",
        spec_patch={"end_date": "2026-08-15"},
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "不在当前赛季计划" in violations[0]


def test_milestone_date_in_range_passes() -> None:
    op = _op(
        MasterPlanDiffOpKind.REPLACE_MILESTONE_DATE,
        milestone_id="ms-1",
        spec_patch={"date": "2026-08-01"},  # within 06-01..11-15
    )
    assert validate_master_diff(_plan(), _diff(op)) == []


def test_milestone_date_outside_season_is_rejected() -> None:
    op = _op(
        MasterPlanDiffOpKind.REPLACE_MILESTONE_DATE,
        milestone_id="ms-1",
        spec_patch={"date": "2027-01-01"},  # past plan end 11-15
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "超出赛季范围" in violations[0]


def test_remove_unknown_milestone_is_rejected() -> None:
    op = _op(MasterPlanDiffOpKind.REMOVE_MILESTONE, milestone_id="ghost")
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "不存在" in violations[0]


def test_rejected_op_is_not_validated() -> None:
    """An explicitly rejected op can't land, so it never produces a violation."""
    op = _op(
        MasterPlanDiffOpKind.RESIZE_PHASE,
        phase_id="phase-1",
        spec_patch={"end_date": "2026-05-15"},  # would invert
        accepted=False,
    )
    assert validate_master_diff(_plan(), _diff(op)) == []


def test_add_phase_outside_season_is_rejected() -> None:
    op = _op(
        MasterPlanDiffOpKind.ADD_PHASE,
        spec_patch={"id": "p2", "name": "X", "start_date": "2025-01-01", "end_date": "2025-03-01"},
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "超出赛季范围" in violations[0]


def test_add_phase_inverted_dates_is_rejected() -> None:
    op = _op(
        MasterPlanDiffOpKind.ADD_PHASE,
        spec_patch={"id": "p2", "name": "X", "start_date": "2026-09-01", "end_date": "2026-08-01"},
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "不早于" in violations[0]


def test_add_phase_within_season_passes() -> None:
    op = _op(
        MasterPlanDiffOpKind.ADD_PHASE,
        spec_patch={"id": "p2", "name": "X", "start_date": "2026-08-01", "end_date": "2026-09-01"},
    )
    assert validate_master_diff(_plan(), _diff(op)) == []


def test_add_milestone_outside_season_is_rejected() -> None:
    op = _op(
        MasterPlanDiffOpKind.ADD_MILESTONE,
        spec_patch={"id": "m2", "type": "long_run", "date": "2027-02-01", "phase_id": "phase-1"},
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "超出赛季范围" in violations[0]


def test_weekly_range_inverted_is_rejected() -> None:
    op = _op(
        MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE,
        phase_id="phase-1",
        spec_patch={"weekly_distance_km_low": 80.0, "weekly_distance_km_high": 40.0},
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "下限" in violations[0]


def test_weekly_range_valid_passes() -> None:
    op = _op(
        MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE,
        phase_id="phase-1",
        spec_patch={"weekly_distance_km_low": 40.0, "weekly_distance_km_high": 80.0},
    )
    assert validate_master_diff(_plan(), _diff(op)) == []


def test_malformed_iso_date_is_rejected() -> None:
    """A non-zero-padded / non-ISO date must be flagged, not string-compared."""
    op = _op(
        MasterPlanDiffOpKind.RESIZE_PHASE,
        phase_id="phase-1",
        spec_patch={"end_date": "2026-9-1"},  # not zero-padded ISO
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "合法 ISO" in violations[0]


def test_add_phase_missing_required_keys_is_rejected() -> None:
    """ADD_PHASE without id/name → would KeyError in apply; gate must reject."""
    op = _op(
        MasterPlanDiffOpKind.ADD_PHASE,
        spec_patch={"start_date": "2026-07-01", "end_date": "2026-08-01"},  # no id/name
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "缺少必填字段" in violations[0]


def test_add_milestone_missing_required_keys_is_rejected() -> None:
    op = _op(
        MasterPlanDiffOpKind.ADD_MILESTONE,
        spec_patch={"date": "2026-08-01"},  # no id/type/phase_id
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "缺少必填字段" in violations[0]


def test_add_milestone_orphan_phase_id_is_rejected() -> None:
    op = _op(
        MasterPlanDiffOpKind.ADD_MILESTONE,
        spec_patch={"id": "m9", "type": "race", "date": "2026-08-01", "phase_id": "ghost"},
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "不存在" in violations[0]


def test_add_phase_id_collision_is_rejected() -> None:
    op = _op(
        MasterPlanDiffOpKind.ADD_PHASE,
        spec_patch={"id": "phase-1", "name": "X", "start_date": "2026-08-01", "end_date": "2026-09-01"},
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "冲突" in violations[0]


def test_add_milestone_id_collision_is_rejected() -> None:
    op = _op(
        MasterPlanDiffOpKind.ADD_MILESTONE,
        spec_patch={"id": "ms-1", "type": "race", "date": "2026-08-01", "phase_id": "phase-1"},
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "冲突" in violations[0]


def test_resize_phase_past_season_end_is_rejected() -> None:
    """RESIZE must stay within the season window (parity with ADD_PHASE)."""
    op = _op(
        MasterPlanDiffOpKind.RESIZE_PHASE,
        phase_id="phase-1",
        spec_patch={"end_date": "2026-12-01"},  # past plan end 2026-11-15
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "超出赛季范围" in violations[0]


def test_weekly_range_non_numeric_is_rejected_not_crash() -> None:
    """Non-numeric weekly range must be a violation, never an unhandled crash."""
    op = _op(
        MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE,
        phase_id="phase-1",
        spec_patch={"weekly_distance_km_low": "abc", "weekly_distance_km_high": 80.0},
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "合法数值" in violations[0]


def test_add_milestone_invalid_type_is_rejected() -> None:
    """An unknown MilestoneType would ValueError→500 in apply; gate must reject."""
    op = _op(
        MasterPlanDiffOpKind.ADD_MILESTONE,
        spec_patch={"id": "m9", "type": "marathon", "date": "2026-08-01", "phase_id": "phase-1"},
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "type 不是合法类型" in violations[0]


def test_add_phase_non_numeric_weekly_bound_is_rejected() -> None:
    """ADD_PHASE coerces weekly bounds via float() in apply; non-numeric must be caught."""
    op = _op(
        MasterPlanDiffOpKind.ADD_PHASE,
        spec_patch={
            "id": "p2", "name": "X", "start_date": "2026-08-01", "end_date": "2026-09-01",
            "weekly_distance_km_low": "abc",
        },
    )
    violations = validate_master_diff(_plan(), _diff(op))
    assert len(violations) == 1
    assert "合法数值" in violations[0]


def test_add_milestone_valid_type_in_window_passes() -> None:
    op = _op(
        MasterPlanDiffOpKind.ADD_MILESTONE,
        spec_patch={"id": "m9", "type": "test_run", "date": "2026-08-01", "phase_id": "phase-1"},
    )
    assert validate_master_diff(_plan(), _diff(op)) == []


def test_multiple_violations_all_reported() -> None:
    bad_resize = _op(
        MasterPlanDiffOpKind.RESIZE_PHASE,
        phase_id="phase-1",
        spec_patch={"end_date": "2026-05-01"},
    )
    bad_ms = _op(
        MasterPlanDiffOpKind.REPLACE_MILESTONE_DATE,
        milestone_id="ms-1",
        spec_patch={"date": "2030-01-01"},
    )
    violations = validate_master_diff(_plan(), _diff(bad_resize, bad_ms))
    assert len(violations) == 2
