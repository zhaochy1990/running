"""Season-impact evaluator — deterministic assessment of how a weekly apply
touches the active master plan (pure, core layer)."""

from __future__ import annotations

from coach.contracts import SeasonImpact
from coach.season_impact import evaluate_weekly_season_impact
from stride_core.master_plan import (
    MasterPlan,
    MasterPlanGoal,
    MasterPlanStatus,
    Milestone,
    MilestoneType,
    Phase,
)
from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan


def _master() -> MasterPlan:
    return MasterPlan(
        plan_id="plan-1",
        user_id="u1",
        status=MasterPlanStatus.ACTIVE,
        goal=MasterPlanGoal(goal_id="g1", target_time="", race_date="2026-11-15"),
        start_date="2026-06-01",
        end_date="2026-11-15",
        phases=[
            Phase(
                id="base",
                name="基础期",
                start_date="2026-06-01",
                end_date="2026-07-31",
                focus="有氧",
                weekly_distance_km_low=50.0,
                weekly_distance_km_high=65.0,
                key_session_types=["长距离", "有氧"],
                milestone_ids=[],
            )
        ],
        milestones=[
            Milestone(
                id="ms-1",
                type=MilestoneType.LONG_RUN,
                date="2026-07-20",
                phase_id="base",
                target="30K",
            )
        ],
        training_principles=["x"],
        generated_by="test",
        version=3,
        created_at="2026-05-01T00:00:00Z",
        updated_at="2026-05-01T00:00:00Z",
    )


def _week(
    *, folder: str = "2026-06-22_06-28(W8)", distances: tuple[float, ...] = (55.0,),
    kinds: tuple[SessionKind, ...] = (SessionKind.RUN,),
) -> WeeklyPlan:
    sessions = tuple(
        PlannedSession(
            date="2026-06-24",
            session_index=i,
            kind=kind,
            summary="run",
            total_distance_m=dist * 1000.0,
        )
        for i, (dist, kind) in enumerate(zip(distances, kinds))
    )
    return WeeklyPlan(week_folder=folder, sessions=sessions, notes_md="x")


def test_no_active_master_is_none() -> None:
    impact = evaluate_weekly_season_impact(_week(), master=None)
    assert impact.level == "none"


def test_week_outside_any_phase_is_none() -> None:
    impact = evaluate_weekly_season_impact(
        _week(folder="2026-12-07_12-13"), master=_master()
    )
    assert impact.level == "none"


def test_volume_within_range_is_none() -> None:
    impact = evaluate_weekly_season_impact(_week(distances=(55.0,)), master=_master())
    assert impact.level == "none"


def test_volume_far_below_low_is_material() -> None:
    # low=50; 10% below low = 45. 40 < 45 => material.
    impact = evaluate_weekly_season_impact(_week(distances=(40.0,)), master=_master())
    assert impact.level == "material"
    assert impact.reasons
    assert isinstance(impact, SeasonImpact)


def test_volume_slightly_below_low_is_advisory() -> None:
    # 48 is below low(50) but within 10% band (>=45) => advisory.
    impact = evaluate_weekly_season_impact(_week(distances=(48.0,)), master=_master())
    assert impact.level == "advisory"


def test_metrics_report_planned_and_target_volume() -> None:
    impact = evaluate_weekly_season_impact(_week(distances=(40.0,)), master=_master())
    assert impact.metrics.get("planned_distance_km") == 40.0
    assert impact.metrics.get("phase_weekly_low_km") == 50.0


def test_removing_all_runs_of_run_focused_phase_is_material() -> None:
    # Pre-apply week had a run; post-apply week has only strength → the phase's
    # key run target is unreachable → material (structural break).
    previous = _week(distances=(55.0,), kinds=(SessionKind.RUN,))
    adjusted = _week(distances=(0.0,), kinds=(SessionKind.STRENGTH,))
    impact = evaluate_weekly_season_impact(
        adjusted, master=_master(), previous=previous
    )
    assert impact.level == "material"
    assert any("关键跑步课" in r for r in impact.reasons)


def test_structural_rule_noop_without_previous_plan() -> None:
    # Same adjusted plan but no previous → structural axis can't run; falls back
    # to the volume axis (0km vs low=50 => material by volume anyway, so use a
    # phase with no volume band to isolate: here volume still fires, so assert it
    # is NOT the structural reason).
    adjusted = _week(distances=(0.0,), kinds=(SessionKind.STRENGTH,))
    impact = evaluate_weekly_season_impact(adjusted, master=_master())
    assert impact.level == "material"
    assert all("关键跑步课" not in r for r in impact.reasons)


def test_keeping_a_run_does_not_trigger_structural_material() -> None:
    previous = _week(distances=(55.0,), kinds=(SessionKind.RUN,))
    adjusted = _week(distances=(52.0,), kinds=(SessionKind.RUN,))
    impact = evaluate_weekly_season_impact(
        adjusted, master=_master(), previous=previous
    )
    # 52 >= low(50) => none; a run remains so no structural break.
    assert impact.level == "none"


def _session(summary: str, km: float, index: int, kind=SessionKind.RUN) -> PlannedSession:
    return PlannedSession(
        date="2026-06-24", session_index=index, kind=kind,
        summary=summary, total_distance_m=km * 1000.0,
    )


def test_deleting_key_long_run_but_keeping_easy_run_is_material() -> None:
    # Phase key_session_types includes "长距离"; the week satisfied it, then the
    # long run is removed while an easy run (and enough volume) remains.
    previous = WeeklyPlan(
        week_folder="2026-06-22_06-28(W8)",
        sessions=(
            _session("周三 长距离 30km", 30.0, 0),
            _session("周五 轻松跑 easy 25km", 25.0, 1),
        ),
        notes_md="x",
    )
    adjusted = WeeklyPlan(
        week_folder="2026-06-22_06-28(W8)",
        sessions=(
            # Long run gone; only an easy run remains. Volume (55) stays >= low.
            _session("周五 轻松跑 easy 55km", 55.0, 0),
        ),
        notes_md="x",
    )
    impact = evaluate_weekly_season_impact(
        adjusted, master=_master(), previous=previous
    )
    assert impact.level == "material"
    assert any("关键课" in r for r in impact.reasons)
