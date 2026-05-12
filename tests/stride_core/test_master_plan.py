"""Unit tests for stride_core.master_plan — T01.

Covers:
- Serialisation / deserialisation round-trip (model_dump / model_validate)
- All Enum values resolve correctly
- Required-field missing → ValidationError
"""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from stride_core.master_plan import (
    MasterPlan,
    MasterPlanStatus,
    MasterPlanVersion,
    Milestone,
    MilestoneType,
    Phase,
)


# ---------------------------------------------------------------------------
# Fixtures — minimal valid instances
# ---------------------------------------------------------------------------

PHASE_DICT = {
    "id": "phase-1",
    "name": "基础期",
    "start_date": "2026-06-01",
    "end_date": "2026-07-31",
    "focus": "提升有氧基础，增加周跑量",
    "weekly_distance_km_low": 50.0,
    "weekly_distance_km_high": 65.0,
    "key_session_types": ["长距离", "有氧", "力量"],
    "milestone_ids": ["ms-1"],
}

MILESTONE_DICT = {
    "id": "ms-1",
    "type": "long_run",
    "date": "2026-07-20",
    "phase_id": "phase-1",
    "target": "30K 节奏跑 4'45/km",
    "completed_actual": None,
}

MASTER_PLAN_DICT = {
    "plan_id": "plan-abc",
    "user_id": "user-uuid-001",
    "status": "draft",
    "goal_id": "goal-xyz",
    "start_date": "2026-06-01",
    "end_date": "2026-11-15",
    "phases": [PHASE_DICT],
    "milestones": [MILESTONE_DICT],
    "training_principles": ["循序渐进", "充分恢复", "专项强化"],
    "generated_by": "gpt-4.1",
    "version": 1,
    "created_at": "2026-05-12T08:00:00+00:00",
    "updated_at": "2026-05-12T08:00:00+00:00",
}

MASTER_PLAN_VERSION_DICT = {
    "version_id": "ver-001",
    "plan_id": "plan-abc",
    "version": 1,
    "changed_at": "2026-05-12T09:00:00+00:00",
    "change_reason": "缩短基础期，比赛提前",
    "change_summary": "将基础期缩短 2 周",
    "snapshot_json": json.dumps(MASTER_PLAN_DICT),
}


# ---------------------------------------------------------------------------
# Enum tests
# ---------------------------------------------------------------------------


def test_master_plan_status_values():
    assert MasterPlanStatus.DRAFT    == "draft"
    assert MasterPlanStatus.ACTIVE   == "active"
    assert MasterPlanStatus.ARCHIVED == "archived"
    assert set(MasterPlanStatus) == {
        MasterPlanStatus.DRAFT,
        MasterPlanStatus.ACTIVE,
        MasterPlanStatus.ARCHIVED,
    }


def test_milestone_type_values():
    assert MilestoneType.RACE          == "race"
    assert MilestoneType.TEST_RUN      == "test_run"
    assert MilestoneType.LONG_RUN      == "long_run"
    assert MilestoneType.STRENGTH_TEST == "strength_test"
    assert set(MilestoneType) == {
        MilestoneType.RACE,
        MilestoneType.TEST_RUN,
        MilestoneType.LONG_RUN,
        MilestoneType.STRENGTH_TEST,
    }


# ---------------------------------------------------------------------------
# Round-trip tests
# ---------------------------------------------------------------------------


def test_phase_round_trip():
    phase = Phase.model_validate(PHASE_DICT)
    assert phase.id == "phase-1"
    assert phase.name == "基础期"
    assert phase.weekly_distance_km_low == 50.0
    assert phase.weekly_distance_km_high == 65.0
    assert phase.key_session_types == ["长距离", "有氧", "力量"]
    assert phase.milestone_ids == ["ms-1"]

    dumped = phase.model_dump()
    phase2 = Phase.model_validate(dumped)
    assert phase == phase2


def test_milestone_round_trip():
    ms = Milestone.model_validate(MILESTONE_DICT)
    assert ms.id == "ms-1"
    assert ms.type == MilestoneType.LONG_RUN
    assert ms.date == "2026-07-20"
    assert ms.phase_id == "phase-1"
    assert ms.target == "30K 节奏跑 4'45/km"
    assert ms.completed_actual is None

    dumped = ms.model_dump()
    ms2 = Milestone.model_validate(dumped)
    assert ms == ms2


def test_milestone_with_completed_actual():
    d = {**MILESTONE_DICT, "completed_actual": "4'52/km 完成"}
    ms = Milestone.model_validate(d)
    assert ms.completed_actual == "4'52/km 完成"
    assert Milestone.model_validate(ms.model_dump()).completed_actual == "4'52/km 完成"


def test_master_plan_round_trip():
    plan = MasterPlan.model_validate(MASTER_PLAN_DICT)
    assert plan.plan_id == "plan-abc"
    assert plan.status == MasterPlanStatus.DRAFT
    assert len(plan.phases) == 1
    assert len(plan.milestones) == 1
    assert plan.version == 1
    assert plan.generated_by == "gpt-4.1"

    dumped = plan.model_dump()
    plan2 = MasterPlan.model_validate(dumped)
    assert plan == plan2


def test_master_plan_json_round_trip():
    plan = MasterPlan.model_validate(MASTER_PLAN_DICT)
    json_str = plan.model_dump_json()
    plan2 = MasterPlan.model_validate_json(json_str)
    assert plan == plan2


def test_master_plan_version_round_trip():
    ver = MasterPlanVersion.model_validate(MASTER_PLAN_VERSION_DICT)
    assert ver.version_id == "ver-001"
    assert ver.plan_id == "plan-abc"
    assert ver.version == 1
    assert "plan-abc" in ver.snapshot_json

    ver2 = MasterPlanVersion.model_validate(ver.model_dump())
    assert ver == ver2


def test_master_plan_active_status():
    d = {**MASTER_PLAN_DICT, "status": "active"}
    plan = MasterPlan.model_validate(d)
    assert plan.status == MasterPlanStatus.ACTIVE


def test_master_plan_archived_status():
    d = {**MASTER_PLAN_DICT, "status": "archived"}
    plan = MasterPlan.model_validate(d)
    assert plan.status == MasterPlanStatus.ARCHIVED


# ---------------------------------------------------------------------------
# Validation error tests — required fields
# ---------------------------------------------------------------------------


def test_master_plan_missing_plan_id_raises():
    d = {k: v for k, v in MASTER_PLAN_DICT.items() if k != "plan_id"}
    with pytest.raises(ValidationError):
        MasterPlan.model_validate(d)


def test_master_plan_missing_user_id_raises():
    d = {k: v for k, v in MASTER_PLAN_DICT.items() if k != "user_id"}
    with pytest.raises(ValidationError):
        MasterPlan.model_validate(d)


def test_master_plan_missing_status_raises():
    d = {k: v for k, v in MASTER_PLAN_DICT.items() if k != "status"}
    with pytest.raises(ValidationError):
        MasterPlan.model_validate(d)


def test_master_plan_missing_goal_id_raises():
    d = {k: v for k, v in MASTER_PLAN_DICT.items() if k != "goal_id"}
    with pytest.raises(ValidationError):
        MasterPlan.model_validate(d)


def test_master_plan_invalid_status_raises():
    d = {**MASTER_PLAN_DICT, "status": "unknown_status"}
    with pytest.raises(ValidationError):
        MasterPlan.model_validate(d)


def test_phase_missing_id_raises():
    d = {k: v for k, v in PHASE_DICT.items() if k != "id"}
    with pytest.raises(ValidationError):
        Phase.model_validate(d)


def test_milestone_missing_type_raises():
    d = {k: v for k, v in MILESTONE_DICT.items() if k != "type"}
    with pytest.raises(ValidationError):
        Milestone.model_validate(d)


def test_milestone_invalid_type_raises():
    d = {**MILESTONE_DICT, "type": "not_a_valid_type"}
    with pytest.raises(ValidationError):
        Milestone.model_validate(d)


def test_master_plan_version_missing_snapshot_json_raises():
    d = {k: v for k, v in MASTER_PLAN_VERSION_DICT.items() if k != "snapshot_json"}
    with pytest.raises(ValidationError):
        MasterPlanVersion.model_validate(d)
