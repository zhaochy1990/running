"""Unit tests for stride_core.master_plan_diff — T02.

Covers:
- Each MasterPlanDiffOpKind has at least one apply test (in-memory mock store)
- Partial acceptance (accepted_op_ids filtering)
- Empty diff → no-op, version not bumped
- ADD_PHASE / ADD_MILESTONE ids come from ops (not regenerated)
- REMOVE_PHASE cascades milestone removal
- ADD_MILESTONE auto-adds to phase.milestone_ids
- REMOVE_MILESTONE removes from phase.milestone_ids
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import pytest

from stride_core.master_plan import (
    MasterPlan,
    MasterPlanStatus,
    MasterPlanVersion,
    Milestone,
    MilestoneType,
    Phase,
)
from stride_core.master_plan_diff import (
    MasterPlanDiff,
    MasterPlanDiffOp,
    MasterPlanDiffOpKind,
    apply_master_plan_diff,
)


# ---------------------------------------------------------------------------
# In-memory mock store
# ---------------------------------------------------------------------------


class InMemoryStore:
    """Minimal MasterPlanStore for testing — no Azure / SQLite dependency."""

    def __init__(self, plan: MasterPlan) -> None:
        self._plans: dict[str, MasterPlan] = {plan.plan_id: plan}
        self._versions: list[MasterPlanVersion] = []

    def get_plan(self, plan_id: str) -> MasterPlan:
        return self._plans[plan_id]

    def save_plan(self, plan: MasterPlan) -> None:
        self._plans[plan.plan_id] = plan

    def add_version(self, version: MasterPlanVersion) -> None:
        self._versions.append(version)


# ---------------------------------------------------------------------------
# Helpers to build test plans
# ---------------------------------------------------------------------------

_TS = "2026-05-12T08:00:00+00:00"


def _make_phase(
    phase_id: str = "phase-1",
    milestone_ids: list[str] | None = None,
    start_date: str = "2026-06-01",
    end_date: str = "2026-07-31",
    focus: str = "基础有氧",
    low: float = 50.0,
    high: float = 65.0,
) -> Phase:
    return Phase(
        id=phase_id,
        name="基础期",
        start_date=start_date,
        end_date=end_date,
        focus=focus,
        weekly_distance_km_low=low,
        weekly_distance_km_high=high,
        key_session_types=["长距离", "有氧"],
        milestone_ids=milestone_ids or [],
    )


def _make_milestone(
    ms_id: str = "ms-1",
    phase_id: str = "phase-1",
    date: str = "2026-07-20",
    target: str = "30K 节奏跑 4'45/km",
) -> Milestone:
    return Milestone(
        id=ms_id,
        type=MilestoneType.LONG_RUN,
        date=date,
        phase_id=phase_id,
        target=target,
    )


def _make_plan(
    phases: list[Phase] | None = None,
    milestones: list[Milestone] | None = None,
) -> MasterPlan:
    return MasterPlan(
        plan_id="plan-test",
        user_id="user-001",
        status=MasterPlanStatus.DRAFT,
        goal_id="goal-1",
        start_date="2026-06-01",
        end_date="2026-11-15",
        phases=phases or [],
        milestones=milestones or [],
        training_principles=["循序渐进"],
        generated_by="gpt-4.1",
        version=1,
        created_at=_TS,
        updated_at=_TS,
    )


def _make_diff(ops: list[MasterPlanDiffOp], plan_id: str = "plan-test") -> MasterPlanDiff:
    return MasterPlanDiff(
        diff_id=str(uuid.uuid4()),
        plan_id=plan_id,
        ops=ops,
        ai_explanation="AI 调整说明",
        created_at=_TS,
    )


def _op(
    op_kind: MasterPlanDiffOpKind,
    phase_id: str | None = None,
    milestone_id: str | None = None,
    spec_patch: dict | None = None,
    accepted: bool | None = True,
) -> MasterPlanDiffOp:
    return MasterPlanDiffOp(
        id=str(uuid.uuid4()),
        op=op_kind,
        phase_id=phase_id,
        milestone_id=milestone_id,
        spec_patch=spec_patch,
        accepted=accepted,
    )


# ---------------------------------------------------------------------------
# Empty diff / no-op
# ---------------------------------------------------------------------------


def test_empty_diff_no_op():
    plan = _make_plan()
    store = InMemoryStore(plan)
    diff = _make_diff([])
    result = apply_master_plan_diff(store, "plan-test", diff, [], "no reason")
    assert result.version == 1  # version NOT bumped
    assert store._versions == []  # no snapshot saved


def test_no_accepted_ops_no_op():
    phase = _make_phase()
    plan = _make_plan(phases=[phase])
    store = InMemoryStore(plan)

    op1 = _op(MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS, phase_id="phase-1",
               spec_patch={"focus": "新重点"}, accepted=True)
    diff = _make_diff([op1])
    # Pass empty accepted_op_ids — op is NOT in the list
    result = apply_master_plan_diff(store, "plan-test", diff, [], "no change")
    assert result.version == 1
    assert store._versions == []


# ---------------------------------------------------------------------------
# ADD_PHASE
# ---------------------------------------------------------------------------


def test_add_phase():
    plan = _make_plan()
    store = InMemoryStore(plan)
    new_id = str(uuid.uuid4())
    op1 = _op(
        MasterPlanDiffOpKind.ADD_PHASE,
        spec_patch={
            "id": new_id,
            "name": "专项期",
            "start_date": "2026-08-01",
            "end_date": "2026-09-30",
            "focus": "速度专项",
            "weekly_distance_km_low": 60.0,
            "weekly_distance_km_high": 75.0,
            "key_session_types": ["间歇", "节奏跑"],
            "milestone_ids": [],
        },
    )
    diff = _make_diff([op1])
    result = apply_master_plan_diff(store, "plan-test", diff, [op1.id], "add phase")
    assert len(result.phases) == 1
    assert result.phases[0].id == new_id  # id comes from op, not regenerated
    assert result.phases[0].name == "专项期"
    assert result.version == 2
    assert len(store._versions) == 1


# ---------------------------------------------------------------------------
# REMOVE_PHASE (with cascade milestone removal)
# ---------------------------------------------------------------------------


def test_remove_phase_cascades_milestones():
    ms = _make_milestone(ms_id="ms-cascade", phase_id="phase-1")
    phase = _make_phase(phase_id="phase-1", milestone_ids=["ms-cascade"])
    plan = _make_plan(phases=[phase], milestones=[ms])
    store = InMemoryStore(plan)

    op1 = _op(MasterPlanDiffOpKind.REMOVE_PHASE, phase_id="phase-1")
    diff = _make_diff([op1])
    result = apply_master_plan_diff(store, "plan-test", diff, [op1.id], "remove phase")
    assert result.phases == []
    assert result.milestones == []  # cascaded
    assert result.version == 2


def test_remove_phase_nonexistent_is_noop_not_error():
    plan = _make_plan()
    store = InMemoryStore(plan)
    op1 = _op(MasterPlanDiffOpKind.REMOVE_PHASE, phase_id="no-such-phase")
    diff = _make_diff([op1])
    # Should not raise; phase not found is a warning, not an error
    result = apply_master_plan_diff(store, "plan-test", diff, [op1.id], "no-op")
    assert result.version == 2  # version still bumped (op was accepted)


# ---------------------------------------------------------------------------
# RESIZE_PHASE
# ---------------------------------------------------------------------------


def test_resize_phase():
    phase = _make_phase(start_date="2026-06-01", end_date="2026-07-31")
    plan = _make_plan(phases=[phase])
    store = InMemoryStore(plan)

    op1 = _op(
        MasterPlanDiffOpKind.RESIZE_PHASE,
        phase_id="phase-1",
        spec_patch={"start_date": "2026-06-15", "end_date": "2026-08-15"},
    )
    diff = _make_diff([op1])
    result = apply_master_plan_diff(store, "plan-test", diff, [op1.id], "resize phase")
    p = result.phases[0]
    assert p.start_date == "2026-06-15"
    assert p.end_date == "2026-08-15"
    assert result.version == 2


# ---------------------------------------------------------------------------
# REPLACE_PHASE_FOCUS
# ---------------------------------------------------------------------------


def test_replace_phase_focus():
    phase = _make_phase(focus="有氧基础")
    plan = _make_plan(phases=[phase])
    store = InMemoryStore(plan)

    op1 = _op(
        MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS,
        phase_id="phase-1",
        spec_patch={"focus": "速度专项训练"},
    )
    diff = _make_diff([op1])
    result = apply_master_plan_diff(store, "plan-test", diff, [op1.id], "new focus")
    assert result.phases[0].focus == "速度专项训练"
    assert result.version == 2


# ---------------------------------------------------------------------------
# REPLACE_WEEKLY_RANGE
# ---------------------------------------------------------------------------


def test_replace_weekly_range():
    phase = _make_phase(low=50.0, high=65.0)
    plan = _make_plan(phases=[phase])
    store = InMemoryStore(plan)

    op1 = _op(
        MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE,
        phase_id="phase-1",
        spec_patch={"weekly_distance_km_low": 55.0, "weekly_distance_km_high": 70.0},
    )
    diff = _make_diff([op1])
    result = apply_master_plan_diff(store, "plan-test", diff, [op1.id], "bump range")
    p = result.phases[0]
    assert p.weekly_distance_km_low == 55.0
    assert p.weekly_distance_km_high == 70.0
    assert result.version == 2


# ---------------------------------------------------------------------------
# ADD_MILESTONE (auto-adds to phase.milestone_ids)
# ---------------------------------------------------------------------------


def test_add_milestone():
    phase = _make_phase(phase_id="phase-1", milestone_ids=[])
    plan = _make_plan(phases=[phase])
    store = InMemoryStore(plan)

    new_ms_id = str(uuid.uuid4())
    op1 = _op(
        MasterPlanDiffOpKind.ADD_MILESTONE,
        spec_patch={
            "id": new_ms_id,
            "type": "race",
            "date": "2026-11-15",
            "phase_id": "phase-1",
            "target": "北京马拉松 sub-3:30",
        },
    )
    diff = _make_diff([op1])
    result = apply_master_plan_diff(store, "plan-test", diff, [op1.id], "add ms")
    assert len(result.milestones) == 1
    assert result.milestones[0].id == new_ms_id  # id from op, not regenerated
    assert result.milestones[0].type == MilestoneType.RACE
    # Auto-added to phase milestone_ids
    assert new_ms_id in result.phases[0].milestone_ids
    assert result.version == 2


# ---------------------------------------------------------------------------
# REMOVE_MILESTONE
# ---------------------------------------------------------------------------


def test_remove_milestone():
    ms = _make_milestone(ms_id="ms-1", phase_id="phase-1")
    phase = _make_phase(phase_id="phase-1", milestone_ids=["ms-1"])
    plan = _make_plan(phases=[phase], milestones=[ms])
    store = InMemoryStore(plan)

    op1 = _op(MasterPlanDiffOpKind.REMOVE_MILESTONE, milestone_id="ms-1")
    diff = _make_diff([op1])
    result = apply_master_plan_diff(store, "plan-test", diff, [op1.id], "remove ms")
    assert result.milestones == []
    assert "ms-1" not in result.phases[0].milestone_ids
    assert result.version == 2


# ---------------------------------------------------------------------------
# REPLACE_MILESTONE_DATE
# ---------------------------------------------------------------------------


def test_replace_milestone_date():
    ms = _make_milestone(ms_id="ms-1", date="2026-07-20")
    phase = _make_phase(milestone_ids=["ms-1"])
    plan = _make_plan(phases=[phase], milestones=[ms])
    store = InMemoryStore(plan)

    op1 = _op(
        MasterPlanDiffOpKind.REPLACE_MILESTONE_DATE,
        milestone_id="ms-1",
        spec_patch={"date": "2026-08-10"},
    )
    diff = _make_diff([op1])
    result = apply_master_plan_diff(store, "plan-test", diff, [op1.id], "shift date")
    assert result.milestones[0].date == "2026-08-10"
    assert result.version == 2


# ---------------------------------------------------------------------------
# REPLACE_MILESTONE_TARGET
# ---------------------------------------------------------------------------


def test_replace_milestone_target():
    ms = _make_milestone(ms_id="ms-1", target="30K 4'45/km")
    phase = _make_phase(milestone_ids=["ms-1"])
    plan = _make_plan(phases=[phase], milestones=[ms])
    store = InMemoryStore(plan)

    op1 = _op(
        MasterPlanDiffOpKind.REPLACE_MILESTONE_TARGET,
        milestone_id="ms-1",
        spec_patch={"target": "32K 4'50/km"},
    )
    diff = _make_diff([op1])
    result = apply_master_plan_diff(store, "plan-test", diff, [op1.id], "new target")
    assert result.milestones[0].target == "32K 4'50/km"
    assert result.version == 2


# ---------------------------------------------------------------------------
# Partial acceptance (accepted_op_ids filtering)
# ---------------------------------------------------------------------------


def test_partial_acceptance():
    """Two ops; only second is in accepted_op_ids — first should be skipped."""
    phase = _make_phase(focus="旧重点", low=50.0, high=65.0)
    plan = _make_plan(phases=[phase])
    store = InMemoryStore(plan)

    op_focus = _op(
        MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS,
        phase_id="phase-1",
        spec_patch={"focus": "新重点（不应采纳）"},
    )
    op_range = _op(
        MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE,
        phase_id="phase-1",
        spec_patch={"weekly_distance_km_low": 60.0, "weekly_distance_km_high": 75.0},
    )
    diff = _make_diff([op_focus, op_range])
    # Only accept the range op
    result = apply_master_plan_diff(store, "plan-test", diff, [op_range.id], "partial")
    p = result.phases[0]
    assert p.focus == "旧重点"               # focus op skipped
    assert p.weekly_distance_km_low == 60.0  # range op applied
    assert result.version == 2


def test_rejected_accepted_field_skipped():
    """Op with accepted=False is filtered from active_ops → treated as empty diff → no version bump."""
    phase = _make_phase(focus="旧重点")
    plan = _make_plan(phases=[phase])
    store = InMemoryStore(plan)

    op1 = _op(
        MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS,
        phase_id="phase-1",
        spec_patch={"focus": "不应采纳"},
        accepted=False,  # explicitly rejected
    )
    diff = _make_diff([op1])
    result = apply_master_plan_diff(store, "plan-test", diff, [op1.id], "rejected")
    # accepted=False means the op is filtered out → active_ops empty → no-op, no version bump
    assert result.phases[0].focus == "旧重点"
    assert result.version == 1  # no active ops → version NOT bumped


# ---------------------------------------------------------------------------
# Snapshot is written before mutation
# ---------------------------------------------------------------------------


def test_snapshot_saved_before_mutation():
    phase = _make_phase(focus="原始重点")
    plan = _make_plan(phases=[phase])
    store = InMemoryStore(plan)

    op1 = _op(
        MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS,
        phase_id="phase-1",
        spec_patch={"focus": "新重点"},
    )
    diff = _make_diff([op1])
    apply_master_plan_diff(store, "plan-test", diff, [op1.id], "snapshot test")

    assert len(store._versions) == 1
    ver = store._versions[0]
    assert ver.plan_id == "plan-test"
    assert ver.version == 1  # snapshot of the OLD version
    # snapshot_json should contain the original focus
    snap = json.loads(ver.snapshot_json)
    assert snap["phases"][0]["focus"] == "原始重点"


# ---------------------------------------------------------------------------
# version bump
# ---------------------------------------------------------------------------


def test_version_bumped_by_one():
    phase = _make_phase()
    plan = _make_plan(phases=[phase])
    assert plan.version == 1
    store = InMemoryStore(plan)

    op1 = _op(
        MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS,
        phase_id="phase-1",
        spec_patch={"focus": "新"},
    )
    diff = _make_diff([op1])
    result = apply_master_plan_diff(store, "plan-test", diff, [op1.id], "bump")
    assert result.version == 2

    # Apply another diff
    op2 = _op(
        MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS,
        phase_id="phase-1",
        spec_patch={"focus": "再新"},
    )
    diff2 = _make_diff([op2], plan_id="plan-test")
    result2 = apply_master_plan_diff(store, "plan-test", diff2, [op2.id], "bump2")
    assert result2.version == 3
