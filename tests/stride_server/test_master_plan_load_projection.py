from __future__ import annotations

import pytest

from stride_core.master_plan import (
    MasterPlan,
    MasterPlanGoal,
    MasterPlanStatus,
    MasterPlanWeek,
    Phase,
    TargetDistance,
    TrainingLoadProjection,
)
from stride_server.coach_adapters.master_plan_load import (
    apply_master_plan_training_load_projection,
)


def _plan(*, with_week: bool = True) -> MasterPlan:
    phase = Phase(
        id="p1",
        name="基础期",
        start_date="2026-07-20",
        end_date="2026-07-26",
        focus="有氧",
        weekly_distance_km_low=40,
        weekly_distance_km_high=50,
        key_session_types=["长距离"],
        milestone_ids=[],
    )
    weeks = [
        MasterPlanWeek(
            week_index=1,
            week_start="2026-07-20",
            phase_id="p1",
            target_weekly_km_low=40,
            target_weekly_km_high=50,
            key_sessions=[],
        )
    ] if with_week else []
    return MasterPlan(
        plan_id="plan-1",
        user_id="user-1",
        status=MasterPlanStatus.ACTIVE,
        goal=MasterPlanGoal(
            goal_id="goal-1",
            distance=TargetDistance.TEN_K,
            race_date="2026-07-26",
            target_time="",
        ),
        start_date="2026-07-20",
        end_date="2026-07-26",
        total_weeks=1,
        phases=[phase],
        milestones=[],
        weeks=weeks,
        weekly_key_sessions=list(weeks),
        training_principles=[],
        generated_by="test",
        version=1,
        created_at="2026-07-15T00:00:00+00:00",
        updated_at="2026-07-15T00:00:00+00:00",
    )


def test_applies_available_projection_to_both_week_aliases() -> None:
    projected = apply_master_plan_training_load_projection(
        _plan(),
        {"weeks": [{
            "week_index": 1,
            "target_training_dose_low": 210.0,
            "target_training_dose_high": 260.0,
        }]},
        calculated_at="2026-07-15T08:30:00+00:00",
    )

    assert projected.training_load_projection.status == "available"
    assert projected.training_load_projection.unavailable_reason is None
    assert projected.weeks[0].target_training_dose_low == 210.0
    assert projected.weekly_key_sessions[0].target_training_dose_high == 260.0


def test_legacy_plan_without_skeleton_is_explicitly_unavailable() -> None:
    projected = apply_master_plan_training_load_projection(
        _plan(with_week=False),
        None,
        calculated_at="2026-07-15T08:30:00+00:00",
    )

    assert projected.training_load_projection.status == "unavailable"
    assert projected.training_load_projection.unavailable_reason == "weekly_skeleton_unavailable"
    assert projected.weeks == []


def test_missing_personal_threshold_keeps_weekly_skeleton_unprojected() -> None:
    projected = apply_master_plan_training_load_projection(
        _plan(),
        {
            "unavailable_reason": "personal_threshold_unavailable",
            "weeks": [{
                "week_index": 1,
                "target_training_dose_low": None,
                "target_training_dose_high": None,
            }],
        },
        calculated_at="2026-07-15T08:30:00+00:00",
        allow_unavailable_without_weeks=False,
    )

    assert projected.training_load_projection.status == "unavailable"
    assert (
        projected.training_load_projection.unavailable_reason
        == "personal_threshold_unavailable"
    )
    assert len(projected.weeks) == 1
    assert projected.weeks[0].target_training_dose_low is None
    assert projected.weekly_key_sessions == projected.weeks


def test_unavailable_projection_rejects_a_nonempty_weekly_skeleton() -> None:
    with pytest.raises(ValueError, match="requires an empty weekly skeleton"):
        MasterPlan.model_validate({
            **_plan().model_dump(mode="json"),
            "training_load_projection": {
                "status": "unavailable",
                "unavailable_reason": "weekly_skeleton_unavailable",
                "calculated_at": "2026-07-15T08:30:00Z",
            },
        })


def test_personal_threshold_unavailable_requires_an_unprojected_skeleton() -> None:
    with pytest.raises(ValueError, match="cannot contain weekly dose"):
        MasterPlan.model_validate({
            **_plan().model_dump(mode="json"),
            "weeks": [{
                **_plan().weeks[0].model_dump(mode="json"),
                "target_training_dose_low": 100.0,
                "target_training_dose_high": 120.0,
            }],
            "weekly_key_sessions": [],
            "training_load_projection": {
                "status": "unavailable",
                "unavailable_reason": "personal_threshold_unavailable",
                "calculated_at": "2026-07-15T08:30:00Z",
            },
        })


def test_partial_projection_is_rejected() -> None:
    with pytest.raises(ValueError, match="week set does not match master plan"):
        apply_master_plan_training_load_projection(_plan(), {"weeks": []})


@pytest.mark.parametrize(
    "calculated_at",
    ["2026-07-15T08:30:00Z", "2026-07-15T08:30:00+00:00"],
)
def test_projection_accepts_utc_iso_timestamps(calculated_at: str) -> None:
    projection = TrainingLoadProjection(
        status="available",
        unavailable_reason=None,
        calculated_at=calculated_at,
    )

    assert projection.calculated_at == calculated_at


@pytest.mark.parametrize(
    "calculated_at",
    ["2026-07-15T08:30:00", "2026-07-15T16:30:00+08:00", "not-a-date"],
)
def test_projection_rejects_non_utc_or_invalid_timestamps(calculated_at: str) -> None:
    with pytest.raises(ValueError, match="ISO 8601 UTC"):
        TrainingLoadProjection(
            status="available",
            unavailable_reason=None,
            calculated_at=calculated_at,
        )
