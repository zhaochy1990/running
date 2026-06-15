"""Stage-3b T3: season-aggregate rule filter cross-phase/cross-week checks.

Covers each of the five rules in ``season_rule_filter`` with a passing case
AND a violating case, plus the report ``.ok`` semantics and degenerate-bundle
graceful degradation.

Plan-dict builders mirror ``tests/coach/test_rule_filter.py`` /
``tests/coach/test_season_bundle.py``.
"""

from __future__ import annotations

from coach.graphs.generation.season_rule_filter import (
    SeasonRuleReport,
    SeasonRuleViolation,
    run_season_rule_filter,
)
from coach.schemas import PhaseWeeks, SeasonPlanBundle
from stride_core.master_plan import (
    MasterPlan,
    MasterPlanStatus,
    Milestone,
    MilestoneType,
    Phase,
    PhaseType,
)


# ---------------------------------------------------------------------------
# Plan-dict builders (mirror tests/coach/test_rule_filter.py)
# ---------------------------------------------------------------------------


def _run_session(date: str, distance_m: int, *, summary: str = "easy run", duration_s: int = 2700):
    return {
        "date": date,
        "session_index": 0,
        "kind": "run",
        "summary": summary,
        "spec": None,  # aspirational — Stage-3a sessions carry no structured spec
        "notes_md": None,
        "total_distance_m": distance_m,
        "total_duration_s": duration_s,
    }


def _week(date: str, total_km: float, *, folder: str, summary: str = "easy run") -> dict:
    """A one-session week whose run km equals ``total_km``."""
    return {
        "schema": "weekly-plan/v1",
        "week_folder": folder,
        "sessions": [_run_session(date, int(total_km * 1000), summary=summary)],
        "nutrition": [],
    }


def _phase(
    phase_id: str,
    phase_type: PhaseType,
    weeks: list[dict],
    *,
    blocked: int = 0,
) -> PhaseWeeks:
    return PhaseWeeks(
        phase_id=phase_id,
        phase_type=phase_type,
        weeks=weeks,
        blocked_week_count=blocked,
    )


def _bundle(phases: list[PhaseWeeks]) -> SeasonPlanBundle:
    return SeasonPlanBundle(
        master_plan_id="mp-test",
        generated_by="anthropic:claude-opus-4-8",
        phases=phases,
    )


def _master_plan(phases: list[Phase], milestones: list[Milestone]) -> MasterPlan:
    return MasterPlan(
        plan_id="mp-test",
        user_id="u-test",
        status=MasterPlanStatus.DRAFT,
        goal_id="g-test",
        start_date="2026-05-04",
        end_date="2026-08-30",
        phases=phases,
        milestones=milestones,
        training_principles=["80/20", "progressive overload"],
        generated_by="anthropic:claude-opus-4-8",
        version=1,
        created_at="2026-05-01T00:00:00+00:00",
        updated_at="2026-05-01T00:00:00+00:00",
    )


def _mp_phase(
    phase_id: str,
    phase_type: PhaseType,
    *,
    km_low: float = 30,
    km_high: float = 60,
    milestone_ids: list[str] | None = None,
) -> Phase:
    return Phase(
        id=phase_id,
        name=phase_id,
        start_date="2026-05-04",
        end_date="2026-06-01",
        focus="x",
        weekly_distance_km_low=km_low,
        weekly_distance_km_high=km_high,
        key_session_types=[],
        milestone_ids=milestone_ids or [],
        phase_type=phase_type,
    )


# ---------------------------------------------------------------------------
# volume_arc
# ---------------------------------------------------------------------------


def test_volume_arc_clean_ramp_passes():
    bundle = _bundle(
        [
            _phase(
                "p1",
                PhaseType.BASE,
                [
                    _week("2026-05-04", 40, folder="w1"),
                    _week("2026-05-11", 44, folder="w2"),
                ],
            ),
            _phase(
                "p2",
                PhaseType.BUILD,
                [
                    _week("2026-05-18", 48, folder="w3"),
                    _week("2026-05-25", 52, folder="w4"),
                ],
            ),
        ]
    )
    mp = _master_plan(
        [_mp_phase("p1", PhaseType.BASE), _mp_phase("p2", PhaseType.BUILD)], []
    )
    report = run_season_rule_filter(bundle, mp)
    assert not any(v.rule == "volume_arc" for v in report.errors()), [
        v.message for v in report.errors()
    ]


def test_volume_arc_within_phase_spike_fails():
    # Within phase 1, week 2 (66km) = 1.65x week 1 (40km) → within-phase spike.
    bundle = _bundle(
        [
            _phase(
                "p1",
                PhaseType.BASE,
                [
                    _week("2026-05-04", 40, folder="w1"),
                    _week("2026-05-11", 66, folder="w2"),
                ],
            ),
        ]
    )
    mp = _master_plan([_mp_phase("p1", PhaseType.BASE)], [])
    report = run_season_rule_filter(bundle, mp)
    arc = [v for v in report.errors() if v.rule == "volume_arc"]
    assert arc, "expected a volume_arc error for the within-phase spike"
    assert arc[0].details["phase_id"] == "p1"


def test_volume_arc_phase_boundary_spike_reported_via_phase_transition():
    # phase 2 week 1 (66km) = 1.5x phase 1's last week (44km) → boundary spike.
    # By design (documented in season_rule_filter), boundary spikes are reported
    # with phase context by check_phase_transition, not volume_arc, to avoid
    # double-reporting the same boundary.
    bundle = _bundle(
        [
            _phase(
                "p1",
                PhaseType.BASE,
                [
                    _week("2026-05-04", 40, folder="w1"),
                    _week("2026-05-11", 44, folder="w2"),
                ],
            ),
            _phase(
                "p2",
                PhaseType.BUILD,
                [
                    _week("2026-05-18", 66, folder="w3"),
                ],
            ),
        ]
    )
    mp = _master_plan(
        [_mp_phase("p1", PhaseType.BASE), _mp_phase("p2", PhaseType.BUILD)], []
    )
    report = run_season_rule_filter(bundle, mp)
    # The boundary spike fires as phase_transition (which names the transition).
    assert any(v.rule == "phase_transition" for v in report.errors())
    assert not report.ok


# ---------------------------------------------------------------------------
# phase_transition
# ---------------------------------------------------------------------------


def test_phase_transition_clean_deload_across_boundary_passes():
    # phase 2 first week (38km) drops below phase 1 last week (50km) → fine.
    bundle = _bundle(
        [
            _phase(
                "p1",
                PhaseType.BUILD,
                [
                    _week("2026-05-04", 46, folder="w1"),
                    _week("2026-05-11", 50, folder="w2"),
                ],
            ),
            _phase(
                "p2",
                PhaseType.RECOVERY,
                [
                    _week("2026-05-18", 38, folder="w3"),
                ],
            ),
        ]
    )
    mp = _master_plan(
        [_mp_phase("p1", PhaseType.BUILD), _mp_phase("p2", PhaseType.RECOVERY)], []
    )
    report = run_season_rule_filter(bundle, mp)
    assert not any(v.rule == "phase_transition" for v in report.errors())


def test_phase_transition_boundary_spike_names_transition():
    bundle = _bundle(
        [
            _phase("p1", PhaseType.BASE, [_week("2026-05-04", 40, folder="w1")]),
            _phase("p2", PhaseType.BUILD, [_week("2026-05-11", 60, folder="w2")]),
        ]
    )
    mp = _master_plan(
        [_mp_phase("p1", PhaseType.BASE), _mp_phase("p2", PhaseType.BUILD)], []
    )
    report = run_season_rule_filter(bundle, mp)
    trans = [v for v in report.errors() if v.rule == "phase_transition"]
    assert trans
    # reports which transition spiked
    assert trans[0].details.get("from_phase_id") == "p1"
    assert trans[0].details.get("to_phase_id") == "p2"


# ---------------------------------------------------------------------------
# milestone_coverage
# ---------------------------------------------------------------------------


def test_milestone_coverage_speed_phase_with_interval_weeks_passes():
    bundle = _bundle(
        [
            _phase(
                "p-speed",
                PhaseType.SPEED,
                [
                    _week(
                        "2026-05-04",
                        40,
                        folder="w1",
                        summary="VO2max intervals 5x1000m",
                    ),
                    _week("2026-05-11", 42, folder="w2", summary="easy aerobic"),
                ],
            ),
        ]
    )
    ms = Milestone(
        id="m1",
        type=MilestoneType.TEST_RUN,
        date="2026-06-01",
        phase_id="p-speed",
        target="5k sub-19",
        metric="race_time_s_5k",
        target_value=1140,
        comparator="<=",
    )
    mp = _master_plan(
        [_mp_phase("p-speed", PhaseType.SPEED, milestone_ids=["m1"])], [ms]
    )
    report = run_season_rule_filter(bundle, mp)
    assert not any(v.rule == "milestone_coverage" for v in report.warnings())


def test_milestone_coverage_speed_phase_without_speed_work_warns():
    bundle = _bundle(
        [
            _phase(
                "p-speed",
                PhaseType.SPEED,
                [
                    _week("2026-05-04", 40, folder="w1", summary="easy run"),
                    _week("2026-05-11", 42, folder="w2", summary="long aerobic run"),
                ],
            ),
        ]
    )
    ms = Milestone(
        id="m1",
        type=MilestoneType.TEST_RUN,
        date="2026-06-01",
        phase_id="p-speed",
        target="5k sub-19",
        metric="race_time_s_5k",
        target_value=1140,
        comparator="<=",
    )
    mp = _master_plan(
        [_mp_phase("p-speed", PhaseType.SPEED, milestone_ids=["m1"])], [ms]
    )
    report = run_season_rule_filter(bundle, mp)
    cov = [v for v in report.warnings() if v.rule == "milestone_coverage"]
    assert cov
    assert report.ok  # warning only, doesn't flip ok


# ---------------------------------------------------------------------------
# taper_peak_sanity
# ---------------------------------------------------------------------------


def test_taper_volume_below_peak_passes():
    bundle = _bundle(
        [
            _phase(
                "p-peak",
                PhaseType.PEAK,
                [
                    _week("2026-05-04", 60, folder="w1"),
                    _week("2026-05-11", 62, folder="w2"),
                ],
            ),
            _phase(
                "p-taper",
                PhaseType.TAPER,
                [
                    _week("2026-05-18", 40, folder="w3"),
                    _week("2026-05-25", 30, folder="w4"),
                ],
            ),
        ]
    )
    mp = _master_plan(
        [_mp_phase("p-peak", PhaseType.PEAK), _mp_phase("p-taper", PhaseType.TAPER)], []
    )
    report = run_season_rule_filter(bundle, mp)
    assert not any(v.rule == "taper_peak_sanity" for v in report.errors())


def test_taper_volume_at_or_above_peak_fails():
    bundle = _bundle(
        [
            _phase(
                "p-peak",
                PhaseType.PEAK,
                [
                    _week("2026-05-04", 50, folder="w1"),
                    _week("2026-05-11", 52, folder="w2"),
                ],
            ),
            _phase(
                "p-taper",
                PhaseType.TAPER,
                [
                    _week("2026-05-18", 60, folder="w3"),
                    _week("2026-05-25", 58, folder="w4"),
                ],
            ),
        ]
    )
    mp = _master_plan(
        [_mp_phase("p-peak", PhaseType.PEAK), _mp_phase("p-taper", PhaseType.TAPER)], []
    )
    report = run_season_rule_filter(bundle, mp)
    assert any(v.rule == "taper_peak_sanity" and v.severity == "error" for v in report.errors())


# ---------------------------------------------------------------------------
# blocked_week_budget
# ---------------------------------------------------------------------------


def test_blocked_week_budget_zero_blocked_passes():
    bundle = _bundle(
        [
            _phase(
                "p1",
                PhaseType.BASE,
                [_week("2026-05-04", 40, folder="w1"), _week("2026-05-11", 42, folder="w2")],
                blocked=0,
            ),
        ]
    )
    mp = _master_plan([_mp_phase("p1", PhaseType.BASE)], [])
    report = run_season_rule_filter(bundle, mp)
    assert not any(v.rule == "blocked_week_budget" for v in report.violations)


def test_blocked_week_budget_over_40_percent_fails():
    # 2 present weeks + 3 blocked = 5 planned, 60% blocked → error.
    bundle = _bundle(
        [
            _phase(
                "p1",
                PhaseType.BASE,
                [_week("2026-05-04", 40, folder="w1"), _week("2026-05-11", 42, folder="w2")],
                blocked=3,
            ),
        ]
    )
    mp = _master_plan([_mp_phase("p1", PhaseType.BASE)], [])
    report = run_season_rule_filter(bundle, mp)
    assert any(
        v.rule == "blocked_week_budget" and v.severity == "error" for v in report.errors()
    )


def test_blocked_week_budget_around_20_percent_warns():
    # 8 present weeks + 2 blocked = 10 planned, 20% blocked → warning, not error.
    weeks = [_week(f"2026-05-{4 + i:02d}", 40 + i, folder=f"w{i}") for i in range(8)]
    bundle = _bundle([_phase("p1", PhaseType.BASE, weeks, blocked=2)])
    mp = _master_plan([_mp_phase("p1", PhaseType.BASE)], [])
    report = run_season_rule_filter(bundle, mp)
    bw = [v for v in report.violations if v.rule == "blocked_week_budget"]
    assert bw and bw[0].severity == "warning"
    assert report.ok


# ---------------------------------------------------------------------------
# report semantics + degenerate input
# ---------------------------------------------------------------------------


def test_report_ok_true_iff_no_errors():
    report = SeasonRuleReport(
        violations=[
            SeasonRuleViolation(rule="r1", severity="warning", message="w"),
        ]
    )
    assert report.ok
    assert report.warnings()
    assert not report.errors()

    report2 = SeasonRuleReport(
        violations=[
            SeasonRuleViolation(rule="r1", severity="error", message="e"),
        ]
    )
    assert not report2.ok


def test_empty_bundle_does_not_crash():
    bundle = _bundle([])
    mp = _master_plan([], [])
    report = run_season_rule_filter(bundle, mp)
    assert isinstance(report, SeasonRuleReport)
    assert report.ok


def test_phase_with_no_weeks_does_not_crash():
    bundle = _bundle(
        [
            _phase("p1", PhaseType.BASE, []),
            _phase("p2", PhaseType.BUILD, [_week("2026-05-11", 40, folder="w1")]),
        ]
    )
    mp = _master_plan(
        [_mp_phase("p1", PhaseType.BASE), _mp_phase("p2", PhaseType.BUILD)], []
    )
    report = run_season_rule_filter(bundle, mp)
    assert isinstance(report, SeasonRuleReport)
