from __future__ import annotations

from coach_eval.master_weekly_quality import evaluate_master_weekly_quality
from stride_core.master_plan import (
    KeySession,
    MasterPlan,
    MasterPlanGoal,
    MasterPlanStatus,
    MasterPlanWeek,
    Phase,
    PhaseType,
    TargetDistance,
)


def _goal() -> MasterPlanGoal:
    return MasterPlanGoal(
        goal_id="g1",
        race_name="test marathon",
        distance=TargetDistance.FM,
        race_date="2026-10-18",
        target_time="2:50:00",
    )


def _phase() -> Phase:
    return Phase(
        id="ph1",
        name="专项期",
        start_date="2026-06-01",
        end_date="2026-07-05",
        focus="build",
        weekly_distance_km_low=55.0,
        weekly_distance_km_high=80.0,
        key_session_types=["long_run", "threshold"],
        milestone_ids=[],
        phase_type=PhaseType.BUILD,
    )


def _week(
    index: int, km: float, *, recovery: bool = False, taper: bool = False
) -> MasterPlanWeek:
    day = 1 + (index - 1) * 7
    return MasterPlanWeek(
        week_index=index,
        week_start=f"2026-06-{day:02d}",
        phase_id="ph1",
        target_weekly_km_low=max(0.0, km - 5.0),
        target_weekly_km_high=km,
        key_sessions=[KeySession(type="long_run", distance_km=round(km * 0.3, 1))]
        if not recovery and not taper
        else [],
        is_recovery_week=recovery,
        is_taper_week=taper,
    )


def _plan(weeks: list[MasterPlanWeek]) -> MasterPlan:
    phase = _phase()
    return MasterPlan(
        plan_id="mp1",
        user_id="u1",
        status=MasterPlanStatus.ACTIVE,
        goal=_goal(),
        start_date=phase.start_date,
        end_date=phase.end_date,
        total_weeks=len(weeks),
        phases=[phase],
        milestones=[],
        weeks=weeks,
        weekly_key_sessions=weeks,
        training_principles=["test"],
        generated_by="test",
        version=1,
        created_at="2026-06-01T00:00:00Z",
        updated_at="2026-06-01T00:00:00Z",
    )


def _rules(report) -> set[str]:
    return {issue.rule for issue in report.issues}


def test_post_recovery_ramp_compares_to_prior_load_week_not_trough() -> None:
    plan = _plan([_week(1, 60.0), _week(2, 42.0, recovery=True), _week(3, 72.0)])

    report = evaluate_master_weekly_quality(plan)

    issue = next(issue for issue in report.issues if issue.rule == "weekly_volume_ramp")
    assert issue.details["previous_load_km"] == 60.0
    assert issue.details["recovery_trough_km"] == 42.0


def test_post_recovery_slow_crawl_from_trough_is_flagged() -> None:
    plan = _plan([_week(1, 75.0), _week(2, 56.3, recovery=True), _week(3, 59.6)])

    report = evaluate_master_weekly_quality(plan)

    assert "weekly_volume_ramp" not in _rules(report)
    assert "post_recovery_rebound_suppressed" in _rules(report)


def test_post_recovery_rebound_near_prior_load_is_ok() -> None:
    plan = _plan([_week(1, 75.0), _week(2, 56.3, recovery=True), _week(3, 78.0)])

    report = evaluate_master_weekly_quality(plan)

    assert "weekly_volume_ramp" not in _rules(report)
    assert "post_recovery_rebound_suppressed" not in _rules(report)


def test_post_recovery_rebound_exact_rounded_ninety_percent_is_ok() -> None:
    plan = _plan([_week(1, 104.0), _week(2, 78.0, recovery=True), _week(3, 93.6)])

    report = evaluate_master_weekly_quality(plan)

    assert "post_recovery_rebound_suppressed" not in _rules(report)


def test_post_recovery_rebound_below_rounded_ninety_percent_is_flagged() -> None:
    plan = _plan([_week(1, 104.0), _week(2, 78.0, recovery=True), _week(3, 93.2)])

    report = evaluate_master_weekly_quality(plan)

    issue = next(
        issue for issue in report.issues if issue.rule == "post_recovery_rebound_suppressed"
    )
    assert issue.details["min_expected_km"] == 93.6


def test_recovery_cut_outside_twenty_to_thirty_percent_is_flagged() -> None:
    deep = evaluate_master_weekly_quality(
        _plan([_week(1, 75.0), _week(2, 45.0, recovery=True)])
    )
    shallow = evaluate_master_weekly_quality(
        _plan([_week(1, 75.0), _week(2, 66.0, recovery=True)])
    )

    assert "recovery_cut_depth" in _rules(deep)
    assert "recovery_cut_depth" in _rules(shallow)


def test_recovery_cut_allows_half_km_rounding_at_thirty_percent_boundary() -> None:
    plan = _plan([_week(1, 92.0), _week(2, 64.0, recovery=True)])

    report = evaluate_master_weekly_quality(plan)

    assert "recovery_cut_depth" not in _rules(report)


def test_taper_cut_is_not_judged_as_ordinary_recovery_depth() -> None:
    plan = _plan([_week(1, 89.0), _week(2, 64.0, taper=True), _week(3, 45.0, taper=True)])

    report = evaluate_master_weekly_quality(plan)

    assert "recovery_cut_depth" not in _rules(report)


def test_missing_weekly_skeleton_is_an_error() -> None:
    plan = _plan([])

    report = evaluate_master_weekly_quality(plan)

    assert "weekly_skeleton_present" in _rules(report)
    assert not report.ok
