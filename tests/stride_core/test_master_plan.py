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
    MasterPlanGoal,
    MasterPlanStatus,
    MasterPlanVersion,
    MasterPlanWeek,
    Milestone,
    MilestoneType,
    Phase,
    TargetDistance,
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

GOAL_DICT = {
    "goal_id": "goal-xyz",
    "race_name": "Shanghai Marathon",
    "distance": "FM",
    "race_date": "2026-11-15",
    "target_time": "3:30:00",
    "timezone": "Asia/Shanghai",
    "location": "Shanghai",
}

WEEK_DICT = {
    "week_index": 1,
    "week_start": "2026-06-01",
    "phase_id": "phase-1",
    "target_weekly_km_low": 50.0,
    "target_weekly_km_high": 60.0,
    "key_sessions": [
        {
            "type": "long_run",
            "distance_km": 24.0,
            "intensity": "z2",
            "purpose": "建立马拉松专项耐力",
        }
    ],
    "is_recovery_week": False,
    "is_taper_week": False,
}

CANONICAL_MASTER_PLAN_DICT = {
    **{k: v for k, v in MASTER_PLAN_DICT.items() if k != "goal_id"},
    "goal": GOAL_DICT,
    "total_weeks": 24,
    "weeks": [WEEK_DICT],
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
    assert MilestoneType.RACE             == "race"
    assert MilestoneType.TEST_RUN         == "test_run"
    assert MilestoneType.LONG_RUN         == "long_run"
    assert MilestoneType.STRENGTH_TEST    == "strength_test"
    assert MilestoneType.BODY_COMPOSITION == "body_composition"
    assert set(MilestoneType) == {
        MilestoneType.RACE,
        MilestoneType.TEST_RUN,
        MilestoneType.LONG_RUN,
        MilestoneType.STRENGTH_TEST,
        MilestoneType.BODY_COMPOSITION,
    }


def test_body_composition_milestone_value():
    assert MilestoneType.BODY_COMPOSITION.value == "body_composition"


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
    assert plan.goal.goal_id == "goal-xyz"
    assert plan.total_weeks > 0

    dumped = plan.model_dump()
    plan2 = MasterPlan.model_validate(dumped)
    assert plan == plan2


def test_master_plan_accepts_embedded_goal_and_weeks():
    plan = MasterPlan.model_validate(CANONICAL_MASTER_PLAN_DICT)

    assert plan.goal.goal_id == "goal-xyz"
    assert plan.goal_id == "goal-xyz"
    assert plan.goal.distance == TargetDistance.FM
    assert plan.goal.target_time == "3:30:00"
    assert plan.total_weeks == 24
    assert len(plan.weeks) == 1
    assert plan.weeks[0].week_index == 1
    assert plan.weekly_key_sessions[0].week_start == "2026-06-01"

    dumped = plan.model_dump(mode="json")
    assert dumped["goal"]["target_time"] == "3:30:00"
    assert dumped["weeks"][0]["target_weekly_km_high"] == 60.0


def test_master_plan_goal_requires_target_time_when_goal_is_provided():
    goal = {k: v for k, v in GOAL_DICT.items() if k != "target_time"}
    with pytest.raises(ValidationError):
        MasterPlanGoal.model_validate(goal)


def test_master_plan_goal_timezone_defaults_to_shanghai():
    goal = {k: v for k, v in GOAL_DICT.items() if k != "timezone"}
    parsed = MasterPlanGoal.model_validate(goal)
    assert parsed.timezone == "Asia/Shanghai"


def test_master_plan_legacy_weekly_key_sessions_populates_weeks():
    data = {**MASTER_PLAN_DICT, "weekly_key_sessions": [WEEK_DICT]}
    plan = MasterPlan.model_validate(data)

    assert len(plan.weeks) == 1
    assert isinstance(plan.weeks[0], MasterPlanWeek)
    assert plan.weeks[0].week_index == 1
    assert plan.weekly_key_sessions[0].week_index == 1


def test_master_plan_rejects_divergent_goal_id_mirror():
    data = {
        **CANONICAL_MASTER_PLAN_DICT,
        "goal_id": "different-goal-id",
    }
    with pytest.raises(ValidationError, match="goal_id must match goal.goal_id"):
        MasterPlan.model_validate(data)


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


def test_phase_type_optional_and_roundtrips():
    from stride_core.master_plan import Phase, PhaseType
    p_old = Phase(id="p1", name="基础期", start_date="2026-06-11", end_date="2026-07-12",
                  focus="f", weekly_distance_km_low=50, weekly_distance_km_high=64,
                  key_session_types=["长距离"], milestone_ids=[])
    assert p_old.phase_type is None
    p_new = p_old.model_copy(update={"phase_type": PhaseType.BASE})
    assert p_new.phase_type == PhaseType.BASE
    assert Phase.model_validate(p_new.model_dump()).phase_type == PhaseType.BASE
    assert {pt.value for pt in PhaseType} == {"base", "build", "speed", "peak", "taper", "recovery"}


def test_milestone_structured_fields_optional():
    from stride_core.master_plan import Milestone, MilestoneType
    m_old = Milestone(id="m1", type=MilestoneType.RACE, date="2026-10-18",
                      phase_id="p1", target="A 2:50")
    assert m_old.metric is None and m_old.target_value is None and m_old.comparator is None
    m_new = Milestone(id="m2", type=MilestoneType.TEST_RUN, date="2026-08-09",
                      phase_id="p2", target="速度周期末 5k 跑进 19:00",
                      metric="race_time_s_5k", target_value=1140.0, comparator="<=")
    dumped = m_new.model_dump()
    assert Milestone.model_validate(dumped).target_value == 1140.0
    assert m_new.comparator == "<="


def test_body_composition_milestone_constructs_and_round_trips():
    """A quantifiable body-composition milestone constructs and survives a
    JSON round-trip (str-Enum value preserved both ways)."""
    ms = Milestone(
        id="ms-bc-1",
        type=MilestoneType.BODY_COMPOSITION,
        date="2026-07-31",
        phase_id="phase-1",
        target="基础期末体脂 ≤ 12%",
        metric="body_fat_pct",
        target_value=12.0,
        comparator="<=",
    )
    assert ms.type == MilestoneType.BODY_COMPOSITION
    assert ms.metric == "body_fat_pct"

    dumped = ms.model_dump(mode="json")
    assert dumped["type"] == "body_composition"
    assert Milestone.model_validate(dumped) == ms


def test_master_plan_round_trip_with_body_composition_milestone():
    """Embedding a BODY_COMPOSITION milestone in a full plan still round-trips
    cleanly — proves the new enum value is inert for the legacy snapshot
    machinery (model_dump_json → model_validate_json)."""
    bc_milestone = {
        "id": "ms-bc-1",
        "type": "body_composition",
        "date": "2026-07-31",
        "phase_id": "phase-1",
        "target": "基础期末体脂 ≤ 12%",
        "metric": "body_fat_pct",
        "target_value": 12.0,
        "comparator": "<=",
    }
    d = {**MASTER_PLAN_DICT, "milestones": [MILESTONE_DICT, bc_milestone]}
    plan = MasterPlan.model_validate(d)
    assert plan.milestones[1].type == MilestoneType.BODY_COMPOSITION

    plan2 = MasterPlan.model_validate_json(plan.model_dump_json())
    assert plan == plan2
