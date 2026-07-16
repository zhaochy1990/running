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
    PhaseType,
    _apply_review_diff,
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


# ---------------------------------------------------------------------------
# weekly_key_sessions clearing on phase-affecting ops (codex round-2 P1 #6)
# ---------------------------------------------------------------------------


def _plan_with_skeleton() -> MasterPlan:
    """A plan that carries non-empty weekly_key_sessions, used to verify
    the clearing behavior on phase-affecting diffs."""
    from stride_core.master_plan import KeySession, WeeklyKeySessions
    phase = _make_phase()
    skeleton = [
        WeeklyKeySessions(
            week_index=1, week_start="2026-06-01", phase_id=phase.id,
            target_weekly_km_low=40.0, target_weekly_km_high=50.0,
            key_sessions=[
                KeySession(type="long_run", distance_km=18.0, intensity="z2"),
            ],
        ),
    ]
    return _make_plan(phases=[phase]).model_copy(
        update={"weeks": skeleton, "weekly_key_sessions": skeleton}
    )


def test_apply_diff_resize_phase_clears_weekly_key_sessions():
    """RESIZE_PHASE invalidates skeleton week dates — must clear."""
    plan = _plan_with_skeleton()
    assert plan.weekly_key_sessions  # baseline: non-empty before
    store = InMemoryStore(plan)
    op = _op(
        MasterPlanDiffOpKind.RESIZE_PHASE,
        phase_id="phase-1",
        spec_patch={"start_date": "2026-06-15", "end_date": "2026-08-15"},
    )
    diff = _make_diff([op])
    result = apply_master_plan_diff(
        store, "plan-test", diff, [op.id], "resize"
    )
    assert result.weeks == []
    assert result.weekly_key_sessions == []


def test_apply_diff_remove_phase_clears_weekly_key_sessions():
    plan = _plan_with_skeleton()
    store = InMemoryStore(plan)
    op = _op(MasterPlanDiffOpKind.REMOVE_PHASE, phase_id="phase-1")
    diff = _make_diff([op])
    result = apply_master_plan_diff(
        store, "plan-test", diff, [op.id], "remove"
    )
    assert result.weeks == []
    assert result.weekly_key_sessions == []


def test_apply_diff_add_phase_clears_weekly_key_sessions():
    plan = _plan_with_skeleton()
    store = InMemoryStore(plan)
    op = _op(
        MasterPlanDiffOpKind.ADD_PHASE,
        spec_patch={
            "id": str(uuid.uuid4()),
            "name": "专项期",
            "start_date": "2026-08-01",
            "end_date": "2026-09-30",
            "focus": "speed",
            "weekly_distance_km_low": 60.0,
            "weekly_distance_km_high": 75.0,
            "key_session_types": ["interval"],
            "milestone_ids": [],
        },
    )
    diff = _make_diff([op])
    result = apply_master_plan_diff(
        store, "plan-test", diff, [op.id], "add"
    )
    assert result.weeks == []
    assert result.weekly_key_sessions == []


def test_apply_diff_replace_weekly_range_clears_weekly_key_sessions():
    plan = _plan_with_skeleton()
    store = InMemoryStore(plan)
    op = _op(
        MasterPlanDiffOpKind.REPLACE_WEEKLY_RANGE,
        phase_id="phase-1",
        spec_patch={"weekly_distance_km_low": 55.0, "weekly_distance_km_high": 72.0},
    )
    diff = _make_diff([op])
    result = apply_master_plan_diff(
        store, "plan-test", diff, [op.id], "ranges"
    )
    assert result.weeks == []
    assert result.weekly_key_sessions == []


def test_apply_diff_focus_change_keeps_weekly_key_sessions():
    """REPLACE_PHASE_FOCUS does NOT shift any week boundary; skeleton stays."""
    plan = _plan_with_skeleton()
    store = InMemoryStore(plan)
    op = _op(
        MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS,
        phase_id="phase-1",
        spec_patch={"focus": "new focus copy"},
    )
    diff = _make_diff([op])
    result = apply_master_plan_diff(
        store, "plan-test", diff, [op.id], "focus"
    )
    assert len(result.weeks) == 1
    assert len(result.weekly_key_sessions) == 1


def test_apply_diff_milestone_change_keeps_weekly_key_sessions():
    """REPLACE_MILESTONE_DATE doesn't affect phases; skeleton stays."""
    from stride_core.master_plan import Milestone, MilestoneType
    phase = _make_phase(milestone_ids=["m-1"])
    ms = Milestone(
        id="m-1", type=MilestoneType.LONG_RUN, date="2026-06-15",
        phase_id="phase-1", target="20K easy",
    )
    plan_base = _make_plan(phases=[phase], milestones=[ms])
    from stride_core.master_plan import KeySession, WeeklyKeySessions
    skeleton = [
        WeeklyKeySessions(
            week_index=1, week_start="2026-06-01", phase_id="phase-1",
            target_weekly_km_low=40.0, target_weekly_km_high=50.0,
            key_sessions=[KeySession(type="long_run", distance_km=18.0)],
        ),
    ]
    plan = plan_base.model_copy(update={
        "weeks": skeleton,
        "weekly_key_sessions": skeleton,
    })
    store = InMemoryStore(plan)
    op = _op(
        MasterPlanDiffOpKind.REPLACE_MILESTONE_DATE,
        milestone_id="m-1",
        spec_patch={"date": "2026-06-22"},
    )
    diff = _make_diff([op])
    result = apply_master_plan_diff(
        store, "plan-test", diff, [op.id], "ms-date"
    )
    assert len(result.weeks) == 1
    assert len(result.weekly_key_sessions) == 1


def test_apply_atomic_target_race_reschedule_updates_plan_and_clears_skeleton():
    plan = _plan_with_skeleton()
    build = plan.phases[0].model_copy(
        update={
            "end_date": "2026-10-31",
            "milestone_ids": [],
        }
    )
    taper = plan.phases[0].model_copy(
        update={
            "id": "phase-taper",
            "name": "调整期",
            "phase_type": PhaseType.TAPER,
            "start_date": "2026-11-01",
            "end_date": "2026-11-15",
            "milestone_ids": ["race"],
        }
    )
    race = Milestone(
        id="race",
        type=MilestoneType.RACE,
        date="2026-11-15",
        phase_id=taper.id,
        target="全马",
    )
    plan = plan.model_copy(
        update={
            "end_date": "2026-11-15",
            "goal": plan.goal.model_copy(update={"race_date": "2026-11-15"}),
            "phases": [build, taper],
            "milestones": [race],
        }
    )
    store = InMemoryStore(plan)
    op = _op(
        MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE,
        milestone_id=race.id,
        spec_patch={
            "race_date": "2026-11-29",
            "plan_end_date": "2026-11-29",
            "milestone_date": "2026-11-29",
            "phase_updates": [
                {
                    "phase_id": build.id,
                    "end_date": "2026-11-14",
                },
                {
                    "phase_id": taper.id,
                    "start_date": "2026-11-15",
                    "end_date": "2026-11-29",
                }
            ],
        },
    )

    result = apply_master_plan_diff(
        store, plan.plan_id, _make_diff([op]), [op.id], "race postponed"
    )

    assert result.goal.race_date == "2026-11-29"
    assert result.end_date == "2026-11-29"
    assert result.total_weeks == 26
    assert result.milestones[0].date == "2026-11-29"
    assert result.phases[0].end_date == "2026-11-14"
    assert result.phases[1].start_date == "2026-11-15"
    assert result.phases[1].end_date == "2026-11-29"
    assert result.weeks == []
    assert result.weekly_key_sessions == []
    assert result.training_load_projection is None


def test_apply_rejects_target_race_reschedule_mixed_with_another_op():
    plan = _plan_with_skeleton()
    store = InMemoryStore(plan)
    race_op = _op(
        MasterPlanDiffOpKind.RESCHEDULE_TARGET_RACE,
        milestone_id="missing",
        spec_patch={"race_date": "2026-11-29"},
    )
    focus_op = _op(
        MasterPlanDiffOpKind.REPLACE_PHASE_FOCUS,
        phase_id=plan.phases[0].id,
        spec_patch={"focus": "x"},
    )

    with pytest.raises(ValueError, match="only accepted operation"):
        apply_master_plan_diff(
            store, plan.plan_id, _make_diff([race_op, focus_op]),
            [race_op.id, focus_op.id], "mixed"
        )


def test_build_target_race_reschedule_rejects_non_future_shanghai_date(monkeypatch):
    from datetime import date

    import stride_core.master_plan_diff as master_plan_diff

    plan = _plan_with_skeleton()
    build = plan.phases[0].model_copy(
        update={"end_date": "2026-10-31", "milestone_ids": []}
    )
    taper = plan.phases[0].model_copy(
        update={
            "id": "phase-taper",
            "phase_type": PhaseType.TAPER,
            "start_date": "2026-11-01",
            "end_date": "2026-11-15",
            "milestone_ids": ["race"],
        }
    )
    race = Milestone(
        id="race", type=MilestoneType.RACE, date="2026-11-15",
        phase_id=taper.id, target="全马",
    )
    plan = plan.model_copy(
        update={
            "end_date": "2026-11-15",
            "goal": plan.goal.model_copy(update={"race_date": "2026-11-15"}),
            "phases": [build, taper],
            "milestones": [race],
        }
    )
    monkeypatch.setattr(master_plan_diff, "today_shanghai", lambda: date(2026, 11, 1))

    with pytest.raises(ValueError, match="future Shanghai date"):
        master_plan_diff.build_target_race_reschedule_patch(
            plan, race.id, "2026-11-01"
        )


def test_build_target_race_reschedule_rejects_taper_shifted_into_past(monkeypatch):
    from datetime import date

    import stride_core.master_plan_diff as master_plan_diff

    plan = _plan_with_skeleton()
    build = plan.phases[0].model_copy(
        update={"end_date": "2026-10-31", "milestone_ids": []}
    )
    taper = plan.phases[0].model_copy(
        update={
            "id": "phase-taper",
            "phase_type": PhaseType.TAPER,
            "start_date": "2026-11-01",
            "end_date": "2026-11-15",
            "milestone_ids": ["race"],
        }
    )
    race = Milestone(
        id="race", type=MilestoneType.RACE, date="2026-11-15",
        phase_id=taper.id, target="全马",
    )
    plan = plan.model_copy(
        update={
            "end_date": "2026-11-15",
            "goal": plan.goal.model_copy(update={"race_date": "2026-11-15"}),
            "phases": [build, taper],
            "milestones": [race],
        }
    )
    monkeypatch.setattr(master_plan_diff, "today_shanghai", lambda: date(2026, 11, 1))

    with pytest.raises(ValueError, match="preserved taper into the past"):
        master_plan_diff.build_target_race_reschedule_patch(
            plan, race.id, "2026-11-08"
        )


def test_build_target_race_reschedule_rejects_existing_phase_gap():
    from stride_core.master_plan_diff import build_target_race_reschedule_patch

    plan = _plan_with_skeleton()
    build = plan.phases[0].model_copy(
        update={"end_date": "2026-10-30", "milestone_ids": []}
    )
    taper = plan.phases[0].model_copy(
        update={
            "id": "phase-taper",
            "phase_type": PhaseType.TAPER,
            "start_date": "2026-11-01",
            "end_date": "2026-11-15",
            "milestone_ids": ["race"],
        }
    )
    race = Milestone(
        id="race", type=MilestoneType.RACE, date="2026-11-15",
        phase_id=taper.id, target="全马",
    )
    plan = plan.model_copy(
        update={
            "end_date": "2026-11-15",
            "goal": plan.goal.model_copy(update={"race_date": "2026-11-15"}),
            "phases": [build, taper],
            "milestones": [race],
        }
    )

    with pytest.raises(ValueError, match="continuous boundary"):
        build_target_race_reschedule_patch(plan, race.id, "2026-11-29")


def test_apply_review_diff_resize_phase_clears_weeks_and_weekly_key_sessions():
    """Draft review apply uses a separate helper; it must clear both aliases."""
    plan = _plan_with_skeleton()
    op = _op(
        MasterPlanDiffOpKind.RESIZE_PHASE,
        phase_id="phase-1",
        spec_patch={"end_date": "2026-08-15"},
    )
    diff = _make_diff([op])

    result = _apply_review_diff(plan, diff, [op.id])

    assert result.weeks == []
    assert result.weekly_key_sessions == []
