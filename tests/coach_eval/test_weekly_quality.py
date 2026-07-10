from __future__ import annotations

from coach.schemas import PhaseReview, PhaseWeeks, SeasonPlanBundle
from coach_eval.weekly_quality import evaluate_season_quality
from stride_core.master_plan import (
    KeySession,
    MasterPlan,
    MasterPlanGoal,
    MasterPlanWeek,
    MasterPlanStatus,
    Milestone,
    MilestoneType,
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


def _phase(phase_type: PhaseType, *, milestone_ids: list[str] | None = None) -> Phase:
    return Phase(
        id="ph1",
        name=phase_type.value,
        start_date="2026-07-06",
        end_date="2026-08-02",
        focus="phase focus",
        weekly_distance_km_low=50.0,
        weekly_distance_km_high=70.0,
        key_session_types=["long_run", "quality"],
        milestone_ids=milestone_ids or [],
        phase_type=phase_type,
    )


def _master(phase: Phase, milestones: list[Milestone] | None = None) -> MasterPlan:
    return MasterPlan(
        plan_id="mp1",
        user_id="u1",
        status=MasterPlanStatus.ACTIVE,
        goal=_goal(),
        start_date=phase.start_date,
        end_date=phase.end_date,
        total_weeks=4,
        phases=[phase],
        milestones=milestones or [],
        training_principles=["test"],
        generated_by="test",
        version=1,
        created_at="2026-07-01T00:00:00Z",
        updated_at="2026-07-01T00:00:00Z",
    )


def _master_with_weeks(phase: Phase, *, week_count: int = 2) -> MasterPlan:
    weeks = [
        MasterPlanWeek(
            week_index=i + 1,
            week_start=f"2026-07-{6 + i * 7:02d}",
            phase_id=phase.id,
            target_weekly_km_low=55.0 + i * 5.0,
            target_weekly_km_high=60.0 + i * 5.0,
            key_sessions=[KeySession(type="long_run", distance_km=20.0 + i)],
        )
        for i in range(week_count)
    ]
    return _master(phase).model_copy(
        update={"total_weeks": week_count, "weeks": weeks, "weekly_key_sessions": weeks}
    )


def _run(date: str, km: float, summary: str, notes: str = "") -> dict:
    return {
        "schema": "plan-session/v1",
        "date": date,
        "session_index": 0,
        "kind": "run",
        "summary": summary,
        "spec": None,
        "notes_md": notes,
        "total_distance_m": km * 1000,
        "total_duration_s": int(km * 330),
        "scheduled_workout_id": None,
    }


def _rest(date: str) -> dict:
    return {
        "schema": "plan-session/v1",
        "date": date,
        "session_index": 0,
        "kind": "rest",
        "summary": "休息",
        "spec": None,
        "notes_md": None,
        "total_distance_m": None,
        "total_duration_s": None,
        "scheduled_workout_id": None,
    }


def _week(folder: str, monday: str, runs: list[tuple[float, str]]) -> dict:
    day = int(monday[-2:])
    sessions = []
    for idx, (km, summary) in enumerate(runs):
        sessions.append(_run(f"2026-07-{day + idx * 2:02d}", km, summary))
    sessions.append(_rest(f"2026-07-{day + 1:02d}"))
    return {
        "schema": "weekly-plan/v1",
        "week_folder": folder,
        "sessions": sessions,
        "nutrition": [],
        "notes_md": "test week",
    }


def _bundle(phase_type: PhaseType, weeks: list[dict]) -> SeasonPlanBundle:
    return SeasonPlanBundle(
        master_plan_id="mp1",
        generated_by="test",
        phases=[
            PhaseWeeks(
                phase_id="ph1",
                phase_type=phase_type,
                weeks=weeks,
                review=PhaseReview(verdict="pass", commentary_md="ok", issues=[]),
            )
        ],
    )


def _rules(report) -> set[str]:
    return {issue.rule for issue in report.issues}


def test_master_week_skeleton_with_empty_generated_bundle_is_error():
    phase = _phase(PhaseType.BUILD)
    master = _master_with_weeks(phase, week_count=2)

    report = evaluate_season_quality(master, _bundle(PhaseType.BUILD, []))

    issue = next(issue for issue in report.issues if issue.rule == "weekly_generation_empty")
    assert issue.severity == "error"
    assert issue.details["expected_weeks"] == 2
    assert issue.details["generated_weeks"] == 0


def test_generated_week_volume_warns_when_it_misses_master_target():
    phase = _phase(PhaseType.TAPER)
    master = _master_with_weeks(phase, week_count=1)
    week = _week("2026-07-06_07-12(W1)", "2026-07-06", [(42.2, "目标马拉松比赛")])

    report = evaluate_season_quality(master, _bundle(PhaseType.TAPER, [week]))

    issue = next(issue for issue in report.issues if issue.rule == "weekly_volume_target_match")
    assert issue.severity == "warning"
    assert issue.details["target_km"] == 60.0
    assert issue.details["generated_km"] == 42.2


def test_after_deload_progression_uses_prior_load_week_not_deload_week():
    phase = _phase(PhaseType.BUILD)
    weeks = [
        _week("2026-07-06_07-12(W1)", "2026-07-06", [(20, "长跑 20km"), (15, "阈值 2k * 4"), (15, "easy")]),
        _week("2026-07-13_07-19(W2)", "2026-07-13", [(22, "长跑 22km"), (18, "tempo"), (15, "easy")]),
        _week("2026-07-20_07-26(W3)", "2026-07-20", [(24, "长跑 24km"), (18, "MP 12km"), (18, "easy")]),
        _week("2026-07-27_08-02(W4)", "2026-07-27", [(16, "轻松长跑 16km"), (12, "easy"), (14, "easy")]),
        _week("2026-08-03_08-09(W5)", "2026-08-03", [(24, "长跑 24km"), (18, "CV 1k * 8"), (20, "easy")]),
    ]

    report = evaluate_season_quality(_master(phase), _bundle(PhaseType.BUILD, weeks))

    assert "weekly_progression" not in _rules(report)
    assert "deload_depth" not in _rules(report)


def test_deload_cut_deeper_than_thirty_percent_is_flagged():
    phase = _phase(PhaseType.BUILD)
    weeks = [
        _week("2026-07-06_07-12(W1)", "2026-07-06", [(20, "长跑 20km"), (15, "阈值"), (15, "easy")]),
        _week("2026-07-13_07-19(W2)", "2026-07-13", [(22, "长跑 22km"), (18, "tempo"), (15, "easy")]),
        _week("2026-07-20_07-26(W3)", "2026-07-20", [(24, "长跑 24km"), (18, "MP"), (18, "easy")]),
        _week("2026-07-27_08-02(W4)", "2026-07-27", [(10, "easy"), (10, "easy"), (10, "easy")]),
    ]

    report = evaluate_season_quality(_master(phase), _bundle(PhaseType.BUILD, weeks))

    assert "deload_depth" in _rules(report)


def test_taper_cut_can_be_deeper_than_ordinary_recovery_week():
    phase = _phase(PhaseType.TAPER)
    weeks = [
        _week("2026-10-05_10-11(W1)", "2026-10-05", [(23, "长跑 23km"), (15, "MP 唤醒"), (38, "easy")]),
        _week("2026-10-12_10-18(W2)", "2026-10-12", [(13, "轻松长跑 13km"), (8, "轻松跑 8km"), (23, "easy")]),
    ]

    report = evaluate_season_quality(_master(phase), _bundle(PhaseType.TAPER, weeks))

    assert "deload_depth" not in _rules(report)


def test_base_flags_repeated_high_intensity_but_speed_allows_it():
    weeks = [
        _week("2026-07-06_07-12(W1)", "2026-07-06", [(18, "长跑 18km"), (10, "VO2max 1k * 6"), (22, "easy")]),
        _week("2026-07-13_07-19(W2)", "2026-07-13", [(20, "长跑 20km"), (10, "400m * 16 短间歇"), (20, "easy")]),
    ]

    base_report = evaluate_season_quality(_master(_phase(PhaseType.BASE)), _bundle(PhaseType.BASE, weeks))
    speed_report = evaluate_season_quality(_master(_phase(PhaseType.SPEED)), _bundle(PhaseType.SPEED, weeks))

    assert "phase_intensity_fit" in _rules(base_report)
    assert "phase_intensity_fit" not in _rules(speed_report)


def test_build_intensity_fit_counts_load_weeks_not_recovery_weeks():
    phase = _phase(PhaseType.BUILD)
    weeks = [
        _week("2026-07-06_07-12(W1)", "2026-07-06", [(20, "长跑 20km"), (12, "阈值 2k * 4"), (18, "easy")]),
        _week("2026-07-13_07-19(W2)", "2026-07-13", [(20, "长跑 20km"), (12, "tempo"), (18, "easy")]),
        _week("2026-07-20_07-26(W3)", "2026-07-20", [(20, "长跑 20km"), (12, "马拉松配速 10km"), (18, "easy")]),
        _week("2026-07-27_08-02(W4)", "2026-07-27", [(16, "轻松长跑 16km"), (10, "easy"), (10, "easy")]),
        _week("2026-08-03_08-09(W5)", "2026-08-03", [(22, "长跑 22km"), (12, "tempo"), (18, "easy")]),
        _week("2026-08-10_08-16(W6)", "2026-08-10", [(22, "长跑 22km"), (12, "马拉松配速 12km"), (18, "easy")]),
        _week("2026-08-17_08-23(W7)", "2026-08-17", [(22, "长跑 22km"), (12, "阈值 2k * 4"), (18, "easy")]),
        _week("2026-08-24_08-30(W8)", "2026-08-24", [(17, "轻松长跑 17km"), (10, "easy"), (10, "easy")]),
        _week("2026-08-31_09-06(W9)", "2026-08-31", [(22, "长跑 22km"), (12, "阈值"), (18, "easy")]),
        _week("2026-09-07_09-13(W10)", "2026-09-07", [(22, "长跑 22km"), (12, "tempo"), (18, "easy")]),
        _week("2026-09-14_09-20(W11)", "2026-09-14", [(22, "长跑 22km"), (12, "马拉松配速 18km"), (18, "easy")]),
        _week("2026-09-21_09-27(W12)", "2026-09-21", [(17, "轻松长跑 17km"), (10, "easy"), (10, "easy")]),
        _week("2026-09-28_10-04(W13)", "2026-09-28", [(22, "长跑 22km"), (12, "阈值 2k * 4"), (18, "easy")]),
    ]

    report = evaluate_season_quality(_master(phase), _bundle(PhaseType.BUILD, weeks))

    assert "phase_intensity_fit" not in _rules(report)


def test_repeated_identical_quality_session_is_flagged():
    phase = _phase(PhaseType.SPEED)
    weeks = [
        _week("2026-07-06_07-12(W1)", "2026-07-06", [(18, "长跑 18km"), (10, "VO2max 1k * 6"), (22, "easy")]),
        _week("2026-07-13_07-19(W2)", "2026-07-13", [(20, "长跑 20km"), (10, "VO2max 1k * 6"), (20, "easy")]),
        _week("2026-07-20_07-26(W3)", "2026-07-20", [(20, "长跑 20km"), (10, "VO2max 1k * 6"), (25, "easy")]),
    ]

    report = evaluate_season_quality(_master(phase), _bundle(PhaseType.SPEED, weeks))

    assert "quality_rotation" in _rules(report)


def test_easy_distance_labels_are_not_classified_as_10k_or_5k_quality():
    phase = _phase(PhaseType.BASE)
    week = _week(
        "2026-07-06_07-12(W1)",
        "2026-07-06",
        [(10, "轻松跑 10km"), (5, "恢复跑 5km"), (20, "z2 长跑 20km")],
    )

    report = evaluate_season_quality(_master(phase), _bundle(PhaseType.BASE, [week]))

    assert report.weeks[0].quality_types == ()
    assert "phase_intensity_fit" not in _rules(report)


def test_milestone_must_be_embedded_in_the_matching_week():
    milestone = Milestone(
        id="m1",
        type=MilestoneType.LONG_RUN,
        date="2026-07-19",
        phase_id="ph1",
        target="完成 31km 长跑，含 16km MP",
        metric="long_run_km",
        comparator=">=",
        target_value=31.0,
    )
    phase = _phase(PhaseType.BUILD, milestone_ids=["m1"])
    weak = _week("2026-07-13_07-19(W2)", "2026-07-13", [(24, "长跑 24km"), (12, "MP 8km"), (14, "easy")])
    strong = _week("2026-07-13_07-19(W2)", "2026-07-13", [(31, "长跑 31km（含 16km @ MP）"), (12, "easy"), (10, "easy")])

    weak_report = evaluate_season_quality(_master(phase, [milestone]), _bundle(PhaseType.BUILD, [weak]))
    strong_report = evaluate_season_quality(_master(phase, [milestone]), _bundle(PhaseType.BUILD, [strong]))

    assert "milestone_embedding" in _rules(weak_report)
    assert "milestone_embedding" not in _rules(strong_report)


def test_long_run_distance_metric_alias_must_be_embedded():
    milestone = Milestone(
        id="m1",
        type=MilestoneType.LONG_RUN,
        date="2026-07-19",
        phase_id="ph1",
        target="完成 31km 长跑，含 16km MP",
        metric="long_run_distance_km",
        comparator=">=",
        target_value=31.0,
    )
    phase = _phase(PhaseType.BUILD, milestone_ids=["m1"])
    weak = _week("2026-07-13_07-19(W2)", "2026-07-13", [(24, "长跑 24km"), (12, "MP 8km"), (14, "easy")])

    report = evaluate_season_quality(_master(phase, [milestone]), _bundle(PhaseType.BUILD, [weak]))

    assert "milestone_embedding" in _rules(report)


def test_partial_bundle_ignores_milestones_from_ungenerated_phases():
    generated_phase = _phase(PhaseType.SPEED)
    other_phase = _phase(PhaseType.BUILD, milestone_ids=["m2"]).model_copy(
        update={"id": "ph2", "start_date": "2026-08-03", "end_date": "2026-08-30"}
    )
    milestone = Milestone(
        id="m2",
        type=MilestoneType.LONG_RUN,
        date="2026-08-16",
        phase_id="ph2",
        target="完成 31km 长跑",
        metric="long_run_km",
        comparator=">=",
        target_value=31.0,
    )
    master = _master(generated_phase, [milestone]).model_copy(
        update={"phases": [generated_phase, other_phase], "milestones": [milestone]}
    )
    weeks = [_week("2026-07-06_07-12(W1)", "2026-07-06", [(18, "VO2max 1k * 5"), (12, "easy"), (20, "长跑 20km")])]

    report = evaluate_season_quality(master, _bundle(PhaseType.SPEED, weeks))

    assert "milestone_embedding" not in _rules(report)


def test_race_time_milestone_is_not_required_as_weekly_session_embedding():
    milestone = Milestone(
        id="m1",
        type=MilestoneType.TEST_RUN,
        date="2026-07-19",
        phase_id="ph1",
        target="HM <= 1:23 only as observation gate for marathon A goal",
        metric="race_time_s_hm",
        comparator="<=",
        target_value=4980.0,
    )
    phase = _phase(PhaseType.PEAK, milestone_ids=["m1"])
    week = _week("2026-07-13_07-19(W2)", "2026-07-13", [(24, "长跑 24km"), (12, "MP 8km"), (14, "easy")])

    report = evaluate_season_quality(_master(phase, [milestone]), _bundle(PhaseType.PEAK, [week]))

    assert "milestone_embedding" not in _rules(report)


def test_race_milestone_type_is_checked_without_name_error():
    milestone = Milestone(
        id="m1",
        type=MilestoneType.RACE,
        date="2026-07-19",
        phase_id="ph1",
        target="目标比赛",
    )
    phase = _phase(PhaseType.TAPER, milestone_ids=["m1"])
    week = _week("2026-07-13_07-19(W2)", "2026-07-13", [(42.2, "目标马拉松比赛")])

    report = evaluate_season_quality(_master(phase, [milestone]), _bundle(PhaseType.TAPER, [week]))

    assert "milestone_embedding" not in _rules(report)
