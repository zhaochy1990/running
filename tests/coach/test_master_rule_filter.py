"""Unit tests for S1 master plan rule_filter — see docs/coach-eval_S1.md § S1 L1 Rules.

Covers all 12 S1 L1 rules:
  - master_schema_validity, phase_count_min, peak_before_race (existing — smoke
    coverage here; deeper coverage in their dedicated cases inline below)
  - phase_duration_balance       (Batch A — incl. race-phase exempt from Batch D)
  - season_window_fits           (Batch A)
  - goal_realism                 (Batch A)
  - weekly_key_sessions_present  (Batch B)
  - weekly_volume_ramp           (Batch B)
  - taper_volume_drop            (Batch B)
  - target_distance_long_run     (Batch B)
  - key_session_density          (Batch B)
  - hard_session_spacing         (Batch B)
"""

from __future__ import annotations

from copy import deepcopy

from coach.graphs.generation.master_rule_filter import (
    _active_plan_view,
    _long_run_share_threshold,
    check_aggressive_goal_volume_ceiling,
    check_distance_taper_length,
    check_frequency_volume_ceiling,
    check_goal_realism,
    check_hard_session_spacing,
    check_injury_return_volume_ceiling,
    check_injury_return_peak_exception_count,
    check_key_session_distance_within_weekly_volume,
    check_key_session_density,
    check_long_run_distance_share,
    check_marathon_pace_specificity,
    check_milestone_week_consistency,
    check_completed_phase_has_no_weeks,
    check_phase_duration_balance,
    check_season_window_fits,
    check_strength_durability_track,
    check_target_distance_volume_ceiling,
    check_target_distance_long_run,
    check_taper_volume_drop,
    check_three_day_extra_run_text,
    check_three_day_quality_stacking,
    check_unauthorized_completed_phase_before_plan,
    check_weekly_key_sessions_present,
    check_weekly_volume_ramp,
    run_master_rule_filter,
)
from stride_core.master_plan import MasterPlan


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _base_plan_dict() -> dict:
    """A canonical valid FM plan with 4 phases (base / build / peak / taper).

    Tuned so every Batch A rule passes by default:
      - 4 phases (≥ 3, satisfies phase_count_min)
      - peak ends 17 days before race (inside 7-21 day taper window)
      - every phase ≥ 14 days and ≤ 112 days
      - plan.start = season_window.start, plan.end < race_date
    """
    return {
        "plan_id": "p1",
        "user_id": "u1",
        "status": "draft",
        "goal_id": "g1",
        "start_date": "2026-05-19",
        "end_date": "2026-10-19",
        "phases": [
            {
                "id": "ph1", "name": "base",
                "start_date": "2026-05-19", "end_date": "2026-07-13",
                "focus": "base", "weekly_distance_km_low": 40,
                "weekly_distance_km_high": 50,
                "key_session_types": ["long_run"], "milestone_ids": [],
            },
            {
                "id": "ph2", "name": "build",
                "start_date": "2026-07-14", "end_date": "2026-09-14",
                "focus": "build", "weekly_distance_km_low": 55,
                "weekly_distance_km_high": 65,
                "key_session_types": ["threshold"], "milestone_ids": [],
            },
            {
                "id": "ph3", "name": "peak",
                "start_date": "2026-09-15", "end_date": "2026-10-02",
                "focus": "peak", "weekly_distance_km_low": 65,
                "weekly_distance_km_high": 70,
                "key_session_types": ["race_pace"], "milestone_ids": [],
            },
            {
                "id": "ph4", "name": "taper",
                "start_date": "2026-10-03", "end_date": "2026-10-18",
                "focus": "taper", "weekly_distance_km_low": 30,
                "weekly_distance_km_high": 40,
                "key_session_types": ["interval"], "milestone_ids": ["m1"],
            },
        ],
        "milestones": [
            {
                "id": "m1", "type": "race", "date": "2026-10-19",
                "phase_id": "ph4", "target": "sub-3:30",
            },
        ],
        "training_principles": ["80/20", "力量与耐久训练每周2次（臀/核心/踝稳定）"],
        "generated_by": "test",
        "version": 1,
        "created_at": "2026-05-19T00:00:00Z",
        "updated_at": "2026-05-19T00:00:00Z",
    }


def _kwargs_full() -> dict:
    return {
        "season_window": {"start_date": "2026-05-19", "end_date": "2026-10-19"},
        "target_race": {
            "distance": "fm",
            "goal_time_s": 12000,
            "race_date": "2026-10-19",
        },
        "prs": {"fm_s": 13200, "10k_s": 2700, "hm_s": 5600},
    }


# ---------------------------------------------------------------------------
# Orchestrator happy path / no-op
# ---------------------------------------------------------------------------


def test_happy_path_with_all_kwargs_passes():
    report = run_master_rule_filter(_base_plan_dict(), **_kwargs_full())
    assert report.ok, [v.rule for v in report.errors()]
    assert report.violations == []


def test_no_kwargs_skips_input_aware_rules():
    """Without target_race / season_window / prs, season_window_fits and
    goal_realism are silent no-ops — only schema-side rules run."""
    report = run_master_rule_filter(_base_plan_dict())
    assert report.ok
    assert not any(v.rule == "season_window_fits" for v in report.violations)
    assert not any(v.rule == "goal_realism" for v in report.violations)


# ---------------------------------------------------------------------------
# strength_durability_track
# ---------------------------------------------------------------------------


def test_strength_track_satisfied_by_training_principle():
    """A durability line in training_principles satisfies the rule (no warning)."""
    plan = MasterPlan.model_validate(_base_plan_dict())  # base has a 力量 principle
    assert check_strength_durability_track(plan) == []


def test_strength_track_satisfied_by_strength_test_milestone():
    plan_dict = _base_plan_dict()
    plan_dict["training_principles"] = ["80/20"]  # strip the durability principle
    plan_dict["milestones"].append({
        "id": "m_str", "type": "strength_test", "date": "2026-08-01",
        "phase_id": "ph2", "target": "单腿提踵每侧25次，左右差<10%",
    })
    plan = MasterPlan.model_validate(plan_dict)
    assert check_strength_durability_track(plan) == []


def test_strength_track_satisfied_by_phase_key_session_type():
    plan_dict = _base_plan_dict()
    plan_dict["training_principles"] = ["80/20"]
    plan_dict["phases"][1]["key_session_types"] = ["threshold", "strength_key"]
    plan = MasterPlan.model_validate(plan_dict)
    assert check_strength_durability_track(plan) == []


def test_run_only_plan_warns():
    """A plan with no strength signal anywhere emits a single warning (not error)."""
    plan_dict = _base_plan_dict()
    plan_dict["training_principles"] = ["80/20"]  # no durability keyword
    plan = MasterPlan.model_validate(plan_dict)  # base phases/milestones are run-only
    violations = check_strength_durability_track(plan)
    assert len(violations) == 1
    assert violations[0].rule == "strength_durability_track"
    assert violations[0].severity == "warning"
    # warning must not flip the report to not-ok (non-blocking)
    plan_dict_full = _base_plan_dict()
    plan_dict_full["training_principles"] = ["80/20"]
    report = run_master_rule_filter(plan_dict_full, **_kwargs_full())
    assert report.ok
    assert any(v.rule == "strength_durability_track" for v in report.violations)


# ---------------------------------------------------------------------------
# marathon_pace_specificity
# ---------------------------------------------------------------------------

_FM_3H20 = {"distance": "fm", "goal_time_s": 12000}   # 3:20 — not sub-3
_FM_SUB3 = {"distance": "fm", "goal_time_s": 10200}   # 2:50 — sub-3


def test_mp_specificity_noop_without_target_or_weeks():
    plan = MasterPlan.model_validate(_base_plan_dict())  # no weekly_key_sessions
    assert check_marathon_pace_specificity(plan, target_race=_FM_3H20) == []
    plan2 = MasterPlan.model_validate(_plan_with_weeks([
        _week(week_index=1, week_start="2026-05-19")]))
    assert check_marathon_pace_specificity(plan2, target_race=None) == []


def test_mp_specificity_noop_for_short_distance():
    plan = MasterPlan.model_validate(_plan_with_weeks([
        _week(week_index=1, week_start="2026-05-19")]))
    assert check_marathon_pace_specificity(
        plan, target_race={"distance": "10k", "goal_time_s": 2400}) == []


def test_mp_specificity_satisfied_by_race_pace_session():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 30, "intensity": "z2"},
        {"type": "race_pace", "distance_km": 18},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    assert check_marathon_pace_specificity(plan, target_race=_FM_3H20) == []


def test_mp_specificity_satisfied_by_goal_pace_milestone():
    plan_dict = _plan_with_weeks([_week(week_index=1, week_start="2026-05-19",
        sessions=[{"type": "long_run", "distance_km": 32, "intensity": "z2"}])])
    plan_dict["milestones"] = [{
        "id": "mp1", "type": "long_run", "date": "2026-08-01", "phase_id": "ph3",
        "target": "32km长距，内含22km马拉松目标配速",
    }]
    plan = MasterPlan.model_validate(plan_dict)
    assert check_marathon_pace_specificity(plan, target_race=_FM_3H20) == []


def test_mp_specificity_satisfied_by_embedded_mp_long_run_purpose():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {
            "type": "long_run",
            "distance_km": 26,
            "intensity": "z2",
            "purpose": "同次长跑内12km马配",
        },
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    assert check_marathon_pace_specificity(plan, target_race=_FM_3H20) == []


def test_mp_specificity_run_only_fm_warns():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 30, "intensity": "z2"},
        {"type": "threshold", "duration_min": 40},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))  # milestones cleared
    v = check_marathon_pace_specificity(plan, target_race=_FM_3H20)
    assert len(v) == 1
    assert v[0].rule == "marathon_pace_specificity"
    assert v[0].severity == "warning"


def test_mp_specificity_sub3_short_long_run_warns():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 30, "intensity": "z2"},
        {"type": "race_pace", "distance_km": 20},  # specificity satisfied
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    v = check_marathon_pace_specificity(plan, target_race=_FM_SUB3)
    # specificity OK (race_pace present) but 30km < 32km for sub-3 → one warning
    assert [x.details.get("peak_long_run_km") for x in v] == [30.0]
    assert all(x.severity == "warning" for x in v)


def test_mp_specificity_sub3_allows_31k_when_a_goal_is_strictly_gated():
    weeks = [_week(week_index=1, week_start="2026-09-14", sessions=[
        {"type": "long_run", "distance_km": 31, "intensity": "z2"},
        {"type": "race_pace", "distance_km": 22},
    ])]
    plan_dict = _plan_with_weeks(weeks)
    plan_dict["training_principles"] = [
        "A=2:50 only if HM + 30km专项 + HR/RPE + 跟腱 response all pass",
    ]
    plan_dict["milestones"] = [{
        "id": "m_gate",
        "type": "long_run",
        "date": "2026-09-20",
        "phase_id": "ph3",
        "target": "30km专项：31km含22km MP，HR/RPE/跟腱全通过才开A",
    }]
    plan = MasterPlan.model_validate(plan_dict)

    assert check_marathon_pace_specificity(plan, target_race=_FM_SUB3) == []


def test_mp_specificity_sub3_still_warns_30k_even_with_gate():
    weeks = [_week(week_index=1, week_start="2026-09-14", sessions=[
        {"type": "long_run", "distance_km": 30, "intensity": "z2"},
        {"type": "race_pace", "distance_km": 20},
    ])]
    plan_dict = _plan_with_weeks(weeks)
    plan_dict["training_principles"] = [
        "A=2:50 only if HM + 30km专项 + HR/RPE + 跟腱 response all pass",
    ]
    plan = MasterPlan.model_validate(plan_dict)

    violations = check_marathon_pace_specificity(plan, target_race=_FM_SUB3)

    assert [x.details.get("peak_long_run_km") for x in violations] == [30.0]


def test_mp_specificity_sub3_allows_30k_with_strict_gate_and_risk_cap():
    weeks = [_week(week_index=1, week_start="2026-09-21", sessions=[
        {"type": "long_run", "distance_km": 30, "intensity": "z2"},
        {"type": "race_pace", "distance_km": 22},
    ])]
    plan_dict = _plan_with_weeks(weeks)
    plan_dict["training_principles"] = [
        "A2:50仅30km含MP22+VO2>58+HR/RPE+跟腱过；显式风险上限，B2:52-2:53。",
    ]
    plan_dict["milestones"] = [{
        "id": "m_gate",
        "type": "long_run",
        "date": "2026-09-27",
        "phase_id": "ph3",
        "target": "30km含MP22km；显式风险上限，跟腱/HR/RPE全过才保A",
    }]
    plan = MasterPlan.model_validate(plan_dict)

    assert check_marathon_pace_specificity(plan, target_race=_FM_SUB3) == []


def test_mp_specificity_sub3_skips_depth_for_severe_low_volume_mismatch():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 24, "intensity": "z2"},
        {"type": "race_pace", "distance_km": 8},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    assert check_marathon_pace_specificity(
        plan,
        target_race={"distance": "fm", "goal_time_s": 10200},
        prs={"fm_s": 13500},
        training_history_summary={"peak_weekly_km_in_window": 38},
    ) == []


def test_mp_specificity_sub3_deep_long_run_ok():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 33, "intensity": "z2"},
        {"type": "race_pace", "distance_km": 22},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    assert check_marathon_pace_specificity(plan, target_race=_FM_SUB3) == []


def test_milestone_week_consistency_warns_when_long_run_target_exceeds_week():
    weeks = [_week(
        week_index=1,
        week_start="2026-09-07",
        sessions=[{"type": "long_run", "distance_km": 18}],
        is_recovery_week=True,
    )]
    plan_dict = _plan_with_weeks(weeks)
    plan_dict["milestones"] = [{
        "id": "m_lr",
        "type": "long_run",
        "date": "2026-09-13",
        "phase_id": "ph3",
        "target": "30km含20km MP，作为9月专项检查前置课",
    }]
    plan = MasterPlan.model_validate(plan_dict)

    violations = check_milestone_week_consistency(plan)

    assert len(violations) == 1
    assert violations[0].rule == "milestone_week_consistency"
    assert violations[0].severity == "warning"
    assert violations[0].details["milestone_target_km"] == 30.0
    assert violations[0].details["week_long_run_km"] == 18.0


def test_milestone_week_consistency_handles_weekly_km_shorthand():
    weeks = [_week(
        week_index=1,
        week_start="2026-09-14",
        km_high=92,
        sessions=[{"type": "long_run", "distance_km": 32}],
    )]
    plan_dict = _plan_with_weeks(weeks)
    plan_dict["milestones"] = [{
        "id": "m_lr",
        "type": "long_run",
        "date": "2026-09-20",
        "phase_id": "ph3",
        "target": "32km/92km峰值周含22km MP；通过才开放A=2:50",
    }]
    plan = MasterPlan.model_validate(plan_dict)

    assert check_milestone_week_consistency(plan) == []


def test_milestone_week_consistency_prefers_structured_long_run_target_value():
    weeks = [_week(
        week_index=1,
        week_start="2026-06-29",
        km_high=38,
        sessions=[{"type": "long_run", "distance_km": 13}],
    )]
    plan_dict = _plan_with_weeks(weeks)
    plan_dict["milestones"] = [{
        "id": "m_lr",
        "type": "long_run",
        "date": "2026-07-05",
        "phase_id": "ph3",
        "target": "13km长跑稳定完成，周量回到38km附近",
        "metric": "long_run_distance_km",
        "target_value": 13,
        "comparator": ">=",
    }]
    plan = MasterPlan.model_validate(plan_dict)

    assert check_milestone_week_consistency(plan) == []


def test_milestone_week_consistency_ignores_weekly_volume_text_mentions():
    weeks = [_week(
        week_index=1,
        week_start="2026-09-14",
        km_high=44,
        sessions=[{"type": "long_run", "distance_km": 22}],
    )]
    plan_dict = _plan_with_weeks(weeks)
    plan_dict["milestones"] = [{
        "id": "m_lr",
        "type": "long_run",
        "date": "2026-09-20",
        "phase_id": "ph3",
        "target": "22km Z2耐受，保持周量44km内",
    }]
    plan = MasterPlan.model_validate(plan_dict)

    assert check_milestone_week_consistency(plan) == []


# ---------------------------------------------------------------------------
# phase_duration_balance
# ---------------------------------------------------------------------------


def test_phase_duration_short_phase_warns():
    """A < 2-week phase emits a warning (severity='warning', not error)."""
    plan_dict = _base_plan_dict()
    # Insert a 4-day micro phase between build and peak by shrinking peak.
    plan_dict["phases"].insert(3, {
        "id": "ph_micro", "name": "micro_tuneup",
        "start_date": "2026-10-03", "end_date": "2026-10-06",  # 3 days
        "focus": "pre-test", "weekly_distance_km_low": 20,
        "weekly_distance_km_high": 25,
        "key_session_types": ["tune_up_race"], "milestone_ids": [],
    })
    # Push taper back so phases don't overlap and race stays 7-21 days after peak.
    plan_dict["phases"][4]["start_date"] = "2026-10-07"
    plan_dict["phases"][4]["end_date"] = "2026-10-18"
    plan = MasterPlan.model_validate(plan_dict)
    violations = check_phase_duration_balance(plan)
    micro = [v for v in violations if v.details["phase_id"] == "ph_micro"]
    assert len(micro) == 1
    assert micro[0].severity == "warning"
    assert micro[0].details["days"] == 4


def test_phase_duration_long_phase_warns():
    """A > 16-week phase emits a warning."""
    plan_dict = _base_plan_dict()
    plan_dict["phases"][0]["start_date"] = "2026-01-01"  # 193-day base
    plan_dict["start_date"] = "2026-01-01"
    plan = MasterPlan.model_validate(plan_dict)
    violations = check_phase_duration_balance(plan)
    over = [v for v in violations if v.details["phase_id"] == "ph1"]
    assert len(over) == 1
    assert over[0].severity == "warning"
    assert over[0].details["days"] > 112


def test_phase_duration_boundary_14_and_112_days_pass():
    """Phases exactly 14 and 112 inclusive calendar days are within range."""
    plan_dict = _base_plan_dict()
    # Replace phases with a 3-phase plan whose durations are exactly the
    # min and max bounds. Drop the race milestone to isolate this check
    # from peak_before_race (which we're not testing here).
    plan_dict["phases"] = [
        {
            "id": "ph1", "name": "base",
            "start_date": "2026-05-19", "end_date": "2026-06-01",  # 14 inclusive days
            "focus": "base", "weekly_distance_km_low": 40,
            "weekly_distance_km_high": 50,
            "key_session_types": ["long_run"], "milestone_ids": [],
        },
        {
            "id": "ph2", "name": "build",
            "start_date": "2026-06-02", "end_date": "2026-09-21",  # 112 inclusive days
            "focus": "build", "weekly_distance_km_low": 55,
            "weekly_distance_km_high": 65,
            "key_session_types": ["threshold"], "milestone_ids": [],
        },
        {
            "id": "ph3", "name": "peak",
            "start_date": "2026-09-22", "end_date": "2026-10-05",  # 14 inclusive days
            "focus": "peak", "weekly_distance_km_low": 65,
            "weekly_distance_km_high": 70,
            "key_session_types": ["race_pace"], "milestone_ids": [],
        },
    ]
    plan_dict["milestones"] = []
    plan_dict["end_date"] = "2026-10-08"
    plan = MasterPlan.model_validate(plan_dict)
    violations = check_phase_duration_balance(plan)
    assert violations == []


def test_phase_duration_two_week_taper_inclusive_dates_passes():
    """A Monday-to-race-Sunday taper spans 14 inclusive days, not 13."""
    plan_dict = _base_plan_dict()
    plan_dict["phases"] = [
        {
            "id": "ph_taper", "name": "赛前减量期",
            "start_date": "2026-10-05", "end_date": "2026-10-18",
            "focus": "taper", "weekly_distance_km_low": 36,
            "weekly_distance_km_high": 68,
            "key_session_types": ["race_pace"], "milestone_ids": [],
        }
    ]
    plan = MasterPlan.model_validate(plan_dict)

    assert check_phase_duration_balance(plan) == []


def test_phase_duration_allows_short_10k_taper_when_distance_specific():
    """A 10K race-week taper can be one natural week."""
    plan_dict = _base_plan_dict()
    plan_dict["phases"] = [
        {
            "id": "ph_taper", "name": "赛周减量期",
            "phase_type": "taper",
            "start_date": "2026-09-14", "end_date": "2026-09-20",
            "focus": "10K race-week taper", "weekly_distance_km_low": 30,
            "weekly_distance_km_high": 38,
            "key_session_types": ["race"], "milestone_ids": [],
        }
    ]
    plan = MasterPlan.model_validate(plan_dict)

    assert check_phase_duration_balance(
        plan, target_race={"distance": "10K"}
    ) == []


def test_phase_duration_keeps_short_fm_taper_warning():
    """A full marathon taper should not be relaxed to one week."""
    plan_dict = _base_plan_dict()
    plan_dict["phases"] = [
        {
            "id": "ph_taper", "name": "减量期",
            "phase_type": "taper",
            "start_date": "2026-10-12", "end_date": "2026-10-18",
            "focus": "too-short marathon taper", "weekly_distance_km_low": 36,
            "weekly_distance_km_high": 52,
            "key_session_types": ["race_pace"], "milestone_ids": [],
        }
    ]
    plan = MasterPlan.model_validate(plan_dict)

    violations = check_phase_duration_balance(
        plan, target_race={"distance": "FM"}
    )

    taper_warns = [v for v in violations if v.details.get("phase_id") == "ph_taper"]
    assert len(taper_warns) == 1
    assert taper_warns[0].rule == "phase_duration_balance"
    assert taper_warns[0].details["days"] == 7


# ---------------------------------------------------------------------------
# season_window_fits
# ---------------------------------------------------------------------------


def test_season_window_no_kwargs_is_noop():
    """check_season_window_fits returns empty when season_window is None."""
    plan = MasterPlan.model_validate(_base_plan_dict())
    assert check_season_window_fits(plan, season_window=None, target_race=None) == []


def test_season_window_plan_starts_before_window_fails():
    plan = MasterPlan.model_validate(_base_plan_dict())
    sw = {"start_date": "2026-06-01", "end_date": "2026-10-19"}  # plan starts 05-19
    violations = check_season_window_fits(plan, season_window=sw, target_race=None)
    assert len(violations) == 1
    assert violations[0].rule == "season_window_fits"
    assert violations[0].severity == "error"
    assert "too early" in violations[0].message


def test_season_window_late_start_skipping_frozen_fixture_fails():
    """Frozen S1 fixtures must not drift forward with wall-clock today.

    Regression: a fixture season_window started 2026-05-19, but generation ran
    on 2026-06-30 and produced plan.start_date=2026-07-06, silently skipping
    the base block. L1 should catch that before the expensive judge round.
    """
    plan_dict = _base_plan_dict()
    plan_dict["start_date"] = "2026-07-06"
    plan_dict["phases"] = plan_dict["phases"][1:]
    plan_dict["phases"][0]["start_date"] = "2026-07-06"
    plan_dict["weekly_key_sessions"] = []
    plan = MasterPlan.model_validate(plan_dict)

    sw = {"start_date": "2026-05-19", "end_date": "2026-10-19"}
    violations = check_season_window_fits(plan, season_window=sw, target_race=None)

    late = [v for v in violations if "skips" in v.message]
    assert len(late) == 1
    assert late[0].rule == "season_window_fits"
    assert late[0].severity == "error"
    assert late[0].details["aligned_season_start"] == "2026-05-25"


def test_season_window_plan_ends_after_window_fails():
    plan = MasterPlan.model_validate(_base_plan_dict())
    sw = {"start_date": "2026-05-19", "end_date": "2026-10-15"}  # plan ends 10-19
    violations = check_season_window_fits(plan, season_window=sw, target_race=None)
    overshoot = [v for v in violations if "overshoot" in v.message]
    assert len(overshoot) == 1
    assert overshoot[0].severity == "error"


def test_season_window_race_outside_window_fails():
    plan = MasterPlan.model_validate(_base_plan_dict())
    sw = {"start_date": "2026-05-19", "end_date": "2026-10-15"}
    tr = {"distance": "fm", "race_date": "2026-10-19"}  # race after window end
    violations = check_season_window_fits(plan, season_window=sw, target_race=tr)
    race_errors = [v for v in violations if "outside season_window" in v.message]
    assert len(race_errors) == 1


def test_season_window_race_on_boundary_passes():
    """Race date == window end is inclusive (within window)."""
    plan = MasterPlan.model_validate(_base_plan_dict())
    sw = {"start_date": "2026-05-19", "end_date": "2026-10-19"}
    tr = {"distance": "fm", "race_date": "2026-10-19"}
    violations = check_season_window_fits(plan, season_window=sw, target_race=tr)
    # Plan also ends 2026-10-19 = window end → fits exactly. Zero errors.
    assert violations == []


def test_season_window_malformed_window_is_noop():
    """Malformed dates in season_window don't raise; they no-op."""
    plan = MasterPlan.model_validate(_base_plan_dict())
    sw = {"start_date": "not-a-date", "end_date": "2026-10-19"}
    # Should not raise; either no-ops or skips just the malformed bound.
    violations = check_season_window_fits(plan, season_window=sw, target_race=None)
    # Whatever the choice, no Python exception should escape.
    assert isinstance(violations, list)


def test_completed_phase_weekly_skeleton_fails():
    """Continuity plans may show completed phases, but must not re-prescribe them."""
    plan_dict = _base_plan_dict()
    plan_dict["phases"][0]["is_completed"] = True
    plan_dict["weeks"] = [
        {
            "week_index": 1,
            "week_start": "2026-05-19",
            "phase_id": "ph1",
            "phase_name": "base",
            "target_weekly_km_low": 40,
            "target_weekly_km_high": 48,
            "key_sessions": [{"type": "long_run", "distance_km": 20}],
        },
        {
            "week_index": 2,
            "week_start": "2026-07-14",
            "phase_id": "ph2",
            "phase_name": "build",
            "target_weekly_km_low": 55,
            "target_weekly_km_high": 60,
            "key_sessions": [{"type": "threshold", "duration_min": 30}],
        },
    ]
    plan_dict["weekly_key_sessions"] = plan_dict["weeks"]
    plan = MasterPlan.model_validate(plan_dict)

    violations = check_completed_phase_has_no_weeks(plan)

    assert len(violations) == 1
    assert violations[0].rule == "completed_phase_has_no_weeks"
    assert violations[0].severity == "error"
    assert violations[0].details["week_indices"] == [1]


def test_completed_phase_before_season_window_fails_without_current_phase_auth():
    plan_dict = _base_plan_dict()
    plan_dict["start_date"] = "2026-05-11"
    plan_dict["phases"][0].update({
        "name": "已完成恢复期",
        "phase_type": "recovery",
        "start_date": "2026-05-11",
        "end_date": "2026-05-18",
        "is_completed": True,
    })
    plan = MasterPlan.model_validate(plan_dict)

    violations = check_unauthorized_completed_phase_before_plan(
        plan,
        season_window={"start_date": "2026-05-19", "end_date": "2026-10-19"},
    )

    assert len(violations) == 1
    assert violations[0].rule == "unauthorized_completed_phase_before_plan"
    assert violations[0].severity == "error"
    assert violations[0].details["phase_start"] == "2026-05-11"


# ---------------------------------------------------------------------------
# goal_realism
# ---------------------------------------------------------------------------


def test_goal_realism_no_kwargs_is_noop():
    plan = MasterPlan.model_validate(_base_plan_dict())
    assert check_goal_realism(plan, target_race=None, prs=None) == []
    assert check_goal_realism(plan, target_race={"distance": "fm"}, prs=None) == []
    assert check_goal_realism(plan, target_race=None, prs={"fm_s": 13200}) == []


def test_goal_realism_aggressive_fm_warns():
    """PR 3:40 (13200s) → goal 2:50 (10200s) = 22.7% on FM (threshold 10%)."""
    plan = MasterPlan.model_validate(_base_plan_dict())
    violations = check_goal_realism(
        plan,
        target_race={"distance": "fm", "goal_time_s": 10200},
        prs={"fm_s": 13200},
    )
    assert len(violations) == 1
    v = violations[0]
    assert v.rule == "goal_realism"
    assert v.severity == "warning"
    assert v.details["distance"] == "fm"
    assert v.details["improvement_pct"] > 10.0


def test_goal_realism_realistic_fm_passes():
    """PR 3:40 (13200) → goal 3:20 (12000) = 9.1% on FM (under 10% threshold)."""
    plan = MasterPlan.model_validate(_base_plan_dict())
    violations = check_goal_realism(
        plan,
        target_race={"distance": "fm", "goal_time_s": 12000},
        prs={"fm_s": 13200},
    )
    assert violations == []


def test_goal_realism_goal_slower_than_pr_passes():
    """Negative improvement (goal slower than PR) is never a violation."""
    plan = MasterPlan.model_validate(_base_plan_dict())
    violations = check_goal_realism(
        plan,
        target_race={"distance": "fm", "goal_time_s": 14000},  # slower
        prs={"fm_s": 13200},
    )
    assert violations == []


def test_goal_realism_distance_thresholds():
    """Spec says: 5k/10k 15%, hm 12%, fm 10%."""
    plan = MasterPlan.model_validate(_base_plan_dict())

    # 10k: 16% improvement crosses 15% threshold → warn
    pr_10k = 3000
    goal_10k = int(pr_10k * (1 - 0.16))
    violations = check_goal_realism(
        plan,
        target_race={"distance": "10k", "goal_time_s": goal_10k},
        prs={"10k_s": pr_10k},
    )
    assert len(violations) == 1

    # 10k: 14% improvement under 15% → pass
    goal_10k_safe = int(pr_10k * (1 - 0.14))
    violations = check_goal_realism(
        plan,
        target_race={"distance": "10k", "goal_time_s": goal_10k_safe},
        prs={"10k_s": pr_10k},
    )
    assert violations == []

    # hm: 13% improvement crosses 12% threshold → warn
    pr_hm = 5700
    goal_hm = int(pr_hm * (1 - 0.13))
    violations = check_goal_realism(
        plan,
        target_race={"distance": "hm", "goal_time_s": goal_hm},
        prs={"hm_s": pr_hm},
    )
    assert len(violations) == 1


def test_goal_realism_missing_pr_key_is_noop():
    plan = MasterPlan.model_validate(_base_plan_dict())
    violations = check_goal_realism(
        plan,
        target_race={"distance": "10k", "goal_time_s": 2400},
        prs={"fm_s": 13200},  # no 10k_s
    )
    assert violations == []


def test_goal_realism_unknown_distance_is_noop():
    """An unrecognised distance key short-circuits without raising."""
    plan = MasterPlan.model_validate(_base_plan_dict())
    violations = check_goal_realism(
        plan,
        target_race={"distance": "marathon", "goal_time_s": 10000},
        prs={"fm_s": 13200},
    )
    assert violations == []


def test_goal_realism_distance_case_insensitive():
    """target_race.distance comparison is case-insensitive."""
    plan = MasterPlan.model_validate(_base_plan_dict())
    violations = check_goal_realism(
        plan,
        target_race={"distance": "FM", "goal_time_s": 10200},
        prs={"fm_s": 13200},
    )
    assert len(violations) == 1


# ---------------------------------------------------------------------------
# Integration via run_master_rule_filter
# ---------------------------------------------------------------------------


def test_orchestrator_collects_violations_from_all_rules():
    """Bad plan triggers errors / warnings from multiple rules at once."""
    plan_dict = _base_plan_dict()
    # 1. Drop a phase to undershoot phase_count_min
    plan_dict["phases"] = plan_dict["phases"][:2]  # only base + build = 2 phases
    # And make plan span big so the < 8wk relaxation doesn't kick in
    # (start 2026-05-19, end 2026-10-19 = 153 days ≥ 56 → effective_min stays 3)
    plan_dict["milestones"][0]["phase_id"] = "ph2"

    # 2. Race date inside, but plan ends after window
    sw = {"start_date": "2026-05-19", "end_date": "2026-10-15"}

    # 3. Aggressive FM goal
    tr = {"distance": "fm", "goal_time_s": 10200, "race_date": "2026-10-19"}
    prs = {"fm_s": 13200}

    report = run_master_rule_filter(plan_dict, season_window=sw, target_race=tr, prs=prs)
    rules_hit = {v.rule for v in report.violations}
    # phase_count_min, season_window_fits, goal_realism all fire
    assert "phase_count_min" in rules_hit
    assert "season_window_fits" in rules_hit
    assert "goal_realism" in rules_hit
    # Errors block — orchestrator should report ok=False
    assert not report.ok


def test_orchestrator_unknown_kwargs_swallowed():
    """**_extra catches unsupported kwargs without raising — forward-compat."""
    plan_dict = _base_plan_dict()
    report = run_master_rule_filter(
        plan_dict,
        season_window={"start_date": "2026-05-19", "end_date": "2026-10-19"},
        target_race={"distance": "fm", "goal_time_s": 12000, "race_date": "2026-10-19"},
        prs={"fm_s": 13200},
        injuries=["knee"],            # unknown kwarg
        hr_zones={"z2": [122, 141]},  # unknown kwarg
    )
    assert report.ok


def test_orchestrator_schema_failure_short_circuits():
    """If the schema rule fails, later rules don't run (they need a parsed plan)."""
    plan_dict = _base_plan_dict()
    del plan_dict["plan_id"]  # required field
    report = run_master_rule_filter(plan_dict, **_kwargs_full())
    rules_hit = {v.rule for v in report.violations}
    assert rules_hit == {"master_schema_validity"}


# ---------------------------------------------------------------------------
# Ensure helpers don't mutate the input plan dict
# ---------------------------------------------------------------------------


def test_orchestrator_does_not_mutate_input():
    plan_dict = _base_plan_dict()
    before = deepcopy(plan_dict)
    run_master_rule_filter(plan_dict, **_kwargs_full())
    assert plan_dict == before


# ---------------------------------------------------------------------------
# Race-phase exempt for phase_duration_balance (Batch D, lives in Batch B PR)
# ---------------------------------------------------------------------------


def _plan_with_race_phase(race_phase_name: str) -> dict:
    """Base plan with a short (4-day) race-week phase tacked on the end."""
    plan_dict = _base_plan_dict()
    plan_dict["phases"][-1]["end_date"] = "2026-10-14"  # shorten taper
    plan_dict["phases"].append({
        "id": "ph_race", "name": race_phase_name,
        "start_date": "2026-10-15", "end_date": "2026-10-19",  # 4 days
        "focus": "race week", "weekly_distance_km_low": 10,
        "weekly_distance_km_high": 15,
        "key_session_types": ["race"], "milestone_ids": ["m1"],
    })
    plan_dict["milestones"][0]["phase_id"] = "ph_race"
    return plan_dict


def test_phase_duration_balance_exempts_race_week_zh():
    """A 4-day phase named '比赛' must NOT trigger the < 14 day warning."""
    plan = MasterPlan.model_validate(_plan_with_race_phase("比赛"))
    violations = check_phase_duration_balance(plan)
    race_warns = [
        v for v in violations
        if v.details.get("phase_name") == "比赛"
    ]
    assert race_warns == []


def test_phase_duration_balance_exempts_race_week_en():
    plan = MasterPlan.model_validate(_plan_with_race_phase("race week"))
    violations = check_phase_duration_balance(plan)
    race_warns = [
        v for v in violations
        if v.details.get("phase_name") == "race week"
    ]
    assert race_warns == []


def test_phase_duration_balance_does_NOT_exempt_prep_phase():
    """'比赛准备期' contains '比赛' but is a peak/prep phase — NOT exempt.

    Tightens the substring-match boundary so a too-short prep block still
    warns. (Tests the _PEAK_PHASE_MARKERS override in _is_race_phase.)
    """
    plan_dict = _base_plan_dict()
    # Rename peak to '比赛准备期' and shrink to 5 days
    plan_dict["phases"][2]["name"] = "比赛准备期"
    plan_dict["phases"][2]["start_date"] = "2026-09-28"
    plan_dict["phases"][2]["end_date"] = "2026-10-02"  # 4 days
    plan = MasterPlan.model_validate(plan_dict)
    violations = check_phase_duration_balance(plan)
    prep = [v for v in violations if v.details.get("phase_name") == "比赛准备期"]
    assert len(prep) == 1
    assert prep[0].details["days"] == 5


# ---------------------------------------------------------------------------
# Helpers for Batch B weekly_key_sessions tests
# ---------------------------------------------------------------------------


def _week(
    *,
    week_index: int,
    week_start: str,
    phase_id: str = "ph3",  # peak phase in _base_plan_dict() — most rule
                            # tests want weeks "inside the peak" by default;
                            # tests can override for non-peak weeks
    km_low: float = 40,
    km_high: float = 50,
    sessions: list[dict] | None = None,
    is_recovery_week: bool = False,
    is_taper_week: bool = False,
) -> dict:
    if sessions is None:
        sessions = [{"type": "long_run", "distance_km": 18, "intensity": "z2"}]
    return {
        "week_index": week_index,
        "week_start": week_start,
        "phase_id": phase_id,
        "target_weekly_km_low": km_low,
        "target_weekly_km_high": km_high,
        "key_sessions": sessions,
        "is_recovery_week": is_recovery_week,
        "is_taper_week": is_taper_week,
    }


def _plan_with_weeks(weeks: list[dict]) -> dict:
    """Build a plan dict whose plan span matches the number of weeks emitted,
    so the weekly_key_sessions_present coverage check doesn't false-positive.

    The plan's start_date is taken from the first week's week_start; end_date
    is computed to give exactly ``len(weeks)`` weeks of coverage (with the
    -1-day tolerance the coverage rule grants for partial last weeks).
    """
    from datetime import date as _date_cls
    from datetime import timedelta

    plan_dict = _base_plan_dict()
    plan_dict["weekly_key_sessions"] = weeks
    if weeks:
        first_start = weeks[0]["week_start"]
        start = _date_cls.fromisoformat(first_start)
        # Each week is 7 days; -1 to land on Sunday of the last week.
        end = start + timedelta(days=len(weeks) * 7 - 1)
        plan_dict["start_date"] = first_start
        plan_dict["end_date"] = end.isoformat()
        # Drop the race milestone & most phases — the test plans here aren't
        # exercising peak_before_race / phase_count_min, and a 1-2 week
        # test plan can't realistically host a 4-phase season.
        plan_dict["milestones"] = []
        plan_dict["phases"] = [
            {
                "id": "ph3", "name": "peak",
                "start_date": first_start, "end_date": end.isoformat(),
                "focus": "test peak", "weekly_distance_km_low": 40,
                "weekly_distance_km_high": 70,
                "key_session_types": ["race_pace"], "milestone_ids": [],
            },
        ]
    return plan_dict


# ---------------------------------------------------------------------------
# weekly_key_sessions_present
# ---------------------------------------------------------------------------


def test_weekly_key_sessions_present_empty_skeleton_is_noop():
    """Empty weekly_key_sessions list → silent no-op (back-compat)."""
    plan = MasterPlan.model_validate(_base_plan_dict())
    assert check_weekly_key_sessions_present(plan) == []


def test_weekly_key_sessions_present_happy_path():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 18},
        {"type": "threshold", "duration_min": 30},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    assert check_weekly_key_sessions_present(plan) == []


def test_weekly_key_sessions_present_zero_sessions_fails():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_weekly_key_sessions_present(plan)
    assert len(violations) == 1
    assert violations[0].severity == "error"
    assert violations[0].details["key_session_count"] == 0


def test_weekly_key_sessions_present_too_many_fails():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 18},
        {"type": "threshold", "duration_min": 30},
        {"type": "tempo", "duration_min": 25},
        {"type": "interval", "duration_min": 35},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_weekly_key_sessions_present(plan)
    assert len(violations) == 1
    assert violations[0].details["key_session_count"] == 4


def test_weekly_key_sessions_present_recovery_week_exempt():
    weeks = [_week(
        week_index=1, week_start="2026-05-19",
        sessions=[], is_recovery_week=True,
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    assert check_weekly_key_sessions_present(plan) == []


def test_weekly_key_sessions_present_taper_week_exempt():
    weeks = [_week(
        week_index=1, week_start="2026-05-19",
        sessions=[], is_taper_week=True,
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    assert check_weekly_key_sessions_present(plan) == []


# ---------------------------------------------------------------------------
# weekly_volume_ramp
# ---------------------------------------------------------------------------


def test_weekly_volume_ramp_within_cap_passes():
    weeks = [
        _week(week_index=1, week_start="2026-05-19", km_high=50),
        _week(week_index=2, week_start="2026-05-26", km_high=55),  # 1.10x
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    assert check_weekly_volume_ramp(plan) == []


def test_weekly_volume_ramp_exceeds_cap_fails():
    weeks = [
        _week(week_index=1, week_start="2026-05-19", km_high=50),
        _week(week_index=2, week_start="2026-05-26", km_high=60),  # 1.20x
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_weekly_volume_ramp(plan)
    assert len(violations) == 1
    assert violations[0].severity == "error"
    assert violations[0].details["ratio"] > 1.10


def test_weekly_volume_ramp_recovery_week_exempt():
    """Drop into a recovery week is allowed (intentional deload)."""
    weeks = [
        _week(week_index=1, week_start="2026-05-19", km_high=65),
        _week(week_index=2, week_start="2026-05-26", km_high=45, is_recovery_week=True),
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    assert check_weekly_volume_ramp(plan) == []


def test_weekly_volume_ramp_taper_week_exempt():
    weeks = [
        _week(week_index=1, week_start="2026-05-19", km_high=65),
        _week(week_index=2, week_start="2026-05-26", km_high=40, is_taper_week=True),
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    assert check_weekly_volume_ramp(plan) == []


def test_weekly_volume_ramp_zero_prev_skipped():
    """If previous week has 0 km_high, no ratio is defined → skip."""
    weeks = [
        _week(week_index=1, week_start="2026-05-19", km_high=0),
        _week(week_index=2, week_start="2026-05-26", km_high=40),
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    assert check_weekly_volume_ramp(plan) == []


# ---------------------------------------------------------------------------
# key_session_distance_within_weekly_volume
# ---------------------------------------------------------------------------


def test_key_session_distance_within_weekly_volume_catches_race_week_under_high():
    weeks = [_week(
        week_index=1,
        week_start="2026-10-12",
        km_low=22,
        km_high=28,
        sessions=[{"type": "race", "distance_km": 42.2}],
        is_taper_week=True,
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    violations = check_key_session_distance_within_weekly_volume(plan)

    assert len(violations) == 1
    assert violations[0].rule == "key_session_distance_within_weekly_volume"
    assert violations[0].severity == "error"
    assert violations[0].details == {
        "week_index": 1,
        "week_start": "2026-10-12",
        "session_index": 0,
        "session_type": "race",
        "session_distance_km": 42.2,
        "target_weekly_km_high": 28.0,
    }


def test_key_session_distance_within_weekly_volume_allows_consistent_race_week():
    weeks = [_week(
        week_index=1,
        week_start="2026-10-12",
        km_low=36,
        km_high=45,
        sessions=[{"type": "race", "distance_km": 42.2}],
        is_taper_week=True,
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    assert check_key_session_distance_within_weekly_volume(plan) == []


def test_key_session_distance_within_weekly_volume_catches_long_run_over_high():
    weeks = [_week(
        week_index=1,
        week_start="2026-09-14",
        km_low=22,
        km_high=28,
        sessions=[{"type": "long_run", "distance_km": 30}],
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    violations = check_key_session_distance_within_weekly_volume(plan)

    assert len(violations) == 1
    assert violations[0].details["session_type"] == "long_run"
    assert violations[0].details["session_distance_km"] == 30.0


# ---------------------------------------------------------------------------
# taper_volume_drop
# ---------------------------------------------------------------------------


def test_taper_volume_drop_happy_path():
    weeks = [
        _week(week_index=1, week_start="2026-05-19", km_high=70),  # peak
        _week(week_index=2, week_start="2026-05-26", km_high=45, is_taper_week=True),
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    assert check_taper_volume_drop(plan) == []


def test_taper_volume_drop_insufficient_drop_fails():
    """20% drop is below the 25% min → violation."""
    weeks = [
        _week(week_index=1, week_start="2026-05-19", km_high=70),
        _week(week_index=2, week_start="2026-05-26", km_high=58, is_taper_week=True),
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_taper_volume_drop(plan)
    assert len(violations) == 1
    assert violations[0].severity == "error"
    assert violations[0].details["drop_pct"] < 25.0


def test_taper_volume_drop_no_taper_week_is_noop():
    """No is_taper_week=True → silent no-op (peak_before_race catches the gap)."""
    weeks = [
        _week(week_index=1, week_start="2026-05-19", km_high=70),
        _week(week_index=2, week_start="2026-05-26", km_high=65),
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    assert check_taper_volume_drop(plan) == []


def test_taper_volume_drop_walks_back_past_recovery_to_find_peak():
    """Recovery week immediately before taper shouldn't trick rule into
    thinking the recovery week is the peak."""
    weeks = [
        _week(week_index=1, week_start="2026-05-19", km_high=72),  # true peak
        _week(week_index=2, week_start="2026-05-26", km_high=50, is_recovery_week=True),  # deload before taper
        _week(week_index=3, week_start="2026-06-02", km_high=45, is_taper_week=True),  # taper drops to 45
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    # peak=72 → taper=45 = 37.5% drop, OK
    assert check_taper_volume_drop(plan) == []


def test_taper_volume_drop_empty_skeleton_is_noop():
    plan = MasterPlan.model_validate(_base_plan_dict())
    assert check_taper_volume_drop(plan) == []


# ---------------------------------------------------------------------------
# target_distance_long_run
# ---------------------------------------------------------------------------


def test_target_distance_long_run_fm_happy_path():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 30},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_target_distance_long_run(plan, target_race={"distance": "fm"})
    assert violations == []


def test_target_distance_long_run_fm_too_short_fails():
    """FM peak long_run < 28km → violation."""
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 22},  # marathon-style training needs 28+
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_target_distance_long_run(plan, target_race={"distance": "fm"})
    assert len(violations) == 1
    assert violations[0].severity == "error"
    assert violations[0].details["max_long_run_km"] == 22.0


def test_target_distance_long_run_allows_24km_for_severe_low_volume_mismatch():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 24},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    assert check_target_distance_long_run(
        plan,
        target_race={"distance": "fm", "goal_time_s": 10200},
        prs={"fm_s": 13500},
        training_history_summary={"peak_weekly_km_in_window": 38},
    ) == []


def test_target_distance_long_run_warns_28km_for_severe_low_volume_mismatch():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 28},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    violations = check_target_distance_long_run(
        plan,
        target_race={"distance": "fm", "goal_time_s": 10200},
        prs={"fm_s": 13500},
        training_history_summary={"peak_weekly_km_in_window": 38},
    )

    assert len(violations) == 1
    assert violations[0].severity == "warning"
    assert violations[0].details["max_allowed_long_run_km"] == 24.0


def test_target_distance_long_run_hm_too_short_fails():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 16},  # HM needs 18+
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_target_distance_long_run(plan, target_race={"distance": "hm"})
    assert len(violations) == 1


def test_target_distance_long_run_no_long_run_session_fails():
    """Skeleton has weeks but no long_run with distance_km → violation."""
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "threshold", "duration_min": 30},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_target_distance_long_run(plan, target_race={"distance": "fm"})
    assert len(violations) == 1
    assert violations[0].details["max_long_run_km_found"] == 0.0


def test_target_distance_long_run_unknown_distance_is_noop():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 8},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_target_distance_long_run(plan, target_race={"distance": "marathon"})
    assert violations == []


def test_target_distance_long_run_case_insensitive():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 22},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_target_distance_long_run(plan, target_race={"distance": "FM"})
    assert len(violations) == 1


def test_target_distance_long_run_uses_max_across_weeks():
    """The max long_run across all weeks counts as 'peak', not a per-week check."""
    weeks = [
        _week(week_index=1, week_start="2026-05-19", sessions=[
            {"type": "long_run", "distance_km": 18},
        ]),
        _week(week_index=2, week_start="2026-05-26", sessions=[
            {"type": "long_run", "distance_km": 30},  # peak — > 28km threshold
        ]),
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_target_distance_long_run(plan, target_race={"distance": "fm"})
    assert violations == []


def test_target_distance_long_run_deload_long_run_doesnt_count_for_peak():
    """A taper-week long_run isn't the peak — base plan's max comes from peak/build weeks."""
    weeks = [
        _week(week_index=1, week_start="2026-05-19", sessions=[
            {"type": "long_run", "distance_km": 22},  # build week max
        ]),
        _week(week_index=2, week_start="2026-05-26", is_taper_week=True, sessions=[
            {"type": "long_run", "distance_km": 30},  # in taper — shouldn't count
        ]),
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_target_distance_long_run(plan, target_race={"distance": "fm"})
    # Build week peak only 22km, below 28km → fail
    assert len(violations) == 1
    assert violations[0].details["max_long_run_km"] == 22.0


def test_target_distance_volume_ceiling_catches_5k_fm_style_volume():
    weeks = [_week(
        week_index=1,
        week_start="2026-05-19",
        km_high=68,
        sessions=[{"type": "long_run", "distance_km": 12}],
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    violations = check_target_distance_volume_ceiling(
        plan, target_race={"distance": "5k"}
    )

    assert len(violations) == 1
    assert violations[0].rule == "target_distance_volume_ceiling"
    assert violations[0].details["max_allowed_km_high"] == 60.0


def test_target_distance_volume_ceiling_catches_10k_hm_style_long_run():
    weeks = [_week(
        week_index=1,
        week_start="2026-05-19",
        km_high=58,
        sessions=[{"type": "long_run", "distance_km": 20}],
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    violations = check_target_distance_volume_ceiling(
        plan, target_race={"distance": "10k"}
    )

    assert len(violations) == 1
    assert violations[0].details["max_allowed_long_run_km"] == 18.0


def test_target_distance_volume_ceiling_allows_hm_specific_volume():
    weeks = [_week(
        week_index=1,
        week_start="2026-05-19",
        km_high=70,
        sessions=[{"type": "long_run", "distance_km": 22}],
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    assert check_target_distance_volume_ceiling(
        plan, target_race={"distance": "hm"}
    ) == []


def test_distance_taper_length_rejects_two_week_hm_taper_phase():
    plan_dict = _base_plan_dict()
    plan_dict["phases"][3]["start_date"] = "2026-10-05"
    plan_dict["phases"][3]["end_date"] = "2026-10-18"
    plan = MasterPlan.model_validate(plan_dict)

    violations = check_distance_taper_length(
        plan,
        target_race={"distance": "hm", "race_date": "2026-10-19"},
    )

    assert len(violations) == 1
    assert violations[0].rule == "distance_taper_length"
    assert violations[0].details["taper_days"] == 14
    assert violations[0].details["max_days"] == 10


def test_distance_taper_length_allows_short_10k_taper_weeks():
    weeks = [
        _week(week_index=1, week_start="2026-05-19", km_high=58),
        _week(
            week_index=2,
            week_start="2026-05-26",
            km_high=42,
            is_taper_week=True,
        ),
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    assert check_distance_taper_length(
        plan,
        target_race={"distance": "10k", "race_date": "2026-05-31"},
    ) == []


def test_distance_taper_length_allows_5k_race_week_mini_taper_phase():
    plan_dict = _base_plan_dict()
    plan_dict["phases"][3]["start_date"] = "2026-10-13"
    plan_dict["phases"][3]["end_date"] = "2026-10-19"
    plan = MasterPlan.model_validate(plan_dict)

    assert check_distance_taper_length(
        plan,
        target_race={"distance": "5k", "race_date": "2026-10-19"},
    ) == []


def test_distance_taper_length_rejects_two_week_5k_taper_phase():
    plan_dict = _base_plan_dict()
    plan_dict["phases"][3]["start_date"] = "2026-10-06"
    plan_dict["phases"][3]["end_date"] = "2026-10-19"
    plan = MasterPlan.model_validate(plan_dict)

    violations = check_distance_taper_length(
        plan,
        target_race={"distance": "5k", "race_date": "2026-10-19"},
    )

    assert len(violations) == 1
    assert violations[0].details["taper_days"] == 14


def test_aggressive_goal_volume_ceiling_catches_goal_risk_plus_volume_record():
    weeks = [_week(
        week_index=1,
        week_start="2026-05-19",
        km_high=92,
        sessions=[{"type": "long_run", "distance_km": 32}],
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    violations = check_aggressive_goal_volume_ceiling(
        plan,
        target_race={"distance": "fm", "goal_time_s": 9900},
        prs={"fm_s": 11400},
        training_history_summary={"peak_weekly_km_in_window": 75},
    )

    assert len(violations) == 1
    assert violations[0].rule == "aggressive_goal_volume_ceiling"
    assert violations[0].details["max_allowed_km_high"] == 82.0
    assert violations[0].details["ratio_allowed_km_high"] == 84.5
    assert violations[0].details["absolute_allowed_km_high"] == 82.0


def test_aggressive_goal_volume_ceiling_rejects_boundary_case_84km_peak():
    weeks = [_week(
        week_index=1,
        week_start="2026-05-19",
        km_high=84,
        sessions=[{"type": "long_run", "distance_km": 29}],
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    violations = check_aggressive_goal_volume_ceiling(
        plan,
        target_race={"distance": "fm", "goal_time_s": 9900},
        prs={"fm_s": 11400},
        training_history_summary={"peak_weekly_km_in_window": 75},
    )

    assert len(violations) == 1
    assert violations[0].details["max_allowed_km_high"] == 82.0


def test_aggressive_goal_volume_ceiling_allows_boundary_case_82km_peak():
    weeks = [_week(
        week_index=1,
        week_start="2026-05-19",
        km_high=82,
        sessions=[{"type": "long_run", "distance_km": 28}],
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    assert check_aggressive_goal_volume_ceiling(
        plan,
        target_race={"distance": "fm", "goal_time_s": 9900},
        prs={"fm_s": 11400},
        training_history_summary={"peak_weekly_km_in_window": 75},
    ) == []


def test_aggressive_goal_volume_ceiling_allows_integer_rounding_buffer():
    weeks = [_week(
        week_index=1,
        week_start="2026-05-19",
        km_high=44,
        sessions=[{"type": "long_run", "distance_km": 24}],
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    assert check_aggressive_goal_volume_ceiling(
        plan,
        target_race={"distance": "fm", "goal_time_s": 10200},
        prs={"fm_s": 13500},
        training_history_summary={"peak_weekly_km_in_window": 38},
    ) == []


def test_aggressive_goal_volume_ceiling_noops_for_realistic_goal():
    weeks = [_week(
        week_index=1,
        week_start="2026-05-19",
        km_high=92,
        sessions=[{"type": "long_run", "distance_km": 32}],
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    assert check_aggressive_goal_volume_ceiling(
        plan,
        target_race={"distance": "fm", "goal_time_s": 10800},
        prs={"fm_s": 11400},
        training_history_summary={"peak_weekly_km_in_window": 75},
    ) == []


# ---------------------------------------------------------------------------
# key_session_density
# ---------------------------------------------------------------------------


def test_key_session_density_3day_user_limit_2():
    """weekly_run_days_max=3 → at most 2 key sessions per week."""
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 18},
        {"type": "threshold", "duration_min": 30},
        {"type": "tempo", "duration_min": 25},  # 3rd — too many
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_key_session_density(plan, weekly_run_days_max=3)
    assert len(violations) == 1
    assert violations[0].severity == "error"
    assert violations[0].details["limit"] == 2


def test_key_session_density_5day_user_limit_3():
    """weekly_run_days_max=5 → at most 3 key sessions per week."""
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 22},
        {"type": "threshold", "duration_min": 35},
        {"type": "tempo", "duration_min": 25},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    assert check_key_session_density(plan, weekly_run_days_max=5) == []


def test_key_session_density_4_sessions_5day_fails():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 22},
        {"type": "threshold", "duration_min": 35},
        {"type": "tempo", "duration_min": 25},
        {"type": "vo2max", "duration_min": 25},  # 4th
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_key_session_density(plan, weekly_run_days_max=5)
    assert len(violations) == 1


def test_key_session_density_race_week_exempt():
    """A week with a `race` session bypasses the density limit."""
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "race", "distance_km": 42.2},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    assert check_key_session_density(plan, weekly_run_days_max=3) == []


def test_key_session_density_missing_max_days_defaults_to_3():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 22},
        {"type": "threshold", "duration_min": 30},
        {"type": "tempo", "duration_min": 25},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    # No weekly_run_days_max → defaults to lenient (3-session) limit
    assert check_key_session_density(plan, weekly_run_days_max=None) == []


def test_three_day_extra_run_text_catches_short_jog_outside_cap():
    plan_dict = _base_plan_dict()
    plan_dict["training_principles"] = [
        "每周3跑外加2天力量/短慢跑，零剂量≤2。",
    ]
    plan = MasterPlan.model_validate(plan_dict)

    violations = check_three_day_extra_run_text(plan, weekly_run_days_max=3)

    assert len(violations) == 1
    assert violations[0].rule == "three_day_extra_run_text"
    assert violations[0].severity == "error"
    assert violations[0].details["field_path"] == "training_principles[0]"


def test_three_day_extra_run_text_allows_strength_only_outside_cap():
    plan_dict = _base_plan_dict()
    plan_dict["training_principles"] = [
        "每周3跑外加2天力量和灵活性，无额外跑步。",
    ]
    plan = MasterPlan.model_validate(plan_dict)

    assert check_three_day_extra_run_text(plan, weekly_run_days_max=3) == []


def test_three_day_extra_run_text_allows_negated_extra_jog():
    plan_dict = _base_plan_dict()
    plan_dict["training_principles"] = [
        "每周固定3跑，不额外加短慢跑；非跑日力量/灵活/休息。",
    ]
    plan = MasterPlan.model_validate(plan_dict)

    assert check_three_day_extra_run_text(plan, weekly_run_days_max=3) == []


def test_three_day_extra_run_text_ignores_full_frequency_runner():
    plan_dict = _base_plan_dict()
    plan_dict["training_principles"] = [
        "每周5跑外加1天短慢跑和1天力量。",
    ]
    plan = MasterPlan.model_validate(plan_dict)

    assert check_three_day_extra_run_text(plan, weekly_run_days_max=5) == []


def test_frequency_volume_ceiling_catches_3day_80k_template():
    weeks = [
        _week(
            week_index=1,
            week_start="2026-05-19",
            km_high=58,
            sessions=[{"type": "long_run", "distance_km": 20}],
        ),
        _week(
            week_index=2,
            week_start="2026-05-26",
            km_high=86,
            sessions=[{"type": "long_run", "distance_km": 30}],
        ),
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    violations = check_frequency_volume_ceiling(plan, weekly_run_days_max=3)

    assert len(violations) == 1
    assert violations[0].rule == "frequency_volume_ceiling"
    assert violations[0].severity == "error"
    assert violations[0].details["target_weekly_km_high"] == 86


def test_frequency_volume_ceiling_ignores_5day_runner():
    weeks = [_week(
        week_index=1,
        week_start="2026-05-19",
        km_high=86,
        sessions=[{"type": "long_run", "distance_km": 30}],
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    assert check_frequency_volume_ceiling(plan, weekly_run_days_max=5) == []


def test_three_day_quality_stacking_catches_mp_long_run_plus_tempo():
    weeks = [_week(
        week_index=1,
        week_start="2026-05-19",
        km_high=42,
        sessions=[
            {"type": "long_run", "distance_km": 26, "purpose": "同次长跑内含10km马配"},
            {"type": "tempo", "duration_min": 30},
        ],
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    violations = check_three_day_quality_stacking(plan, weekly_run_days_max=3)

    assert len(violations) == 1
    assert violations[0].rule == "three_day_quality_stacking"
    assert violations[0].details["stacked_hard_types"] == ["tempo"]


def test_three_day_quality_stacking_allows_medium_aerobic_placeholder_absent():
    weeks = [_week(
        week_index=1,
        week_start="2026-05-19",
        km_high=42,
        sessions=[{"type": "long_run", "distance_km": 26, "purpose": "同次长跑内含10km马配"}],
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    assert check_three_day_quality_stacking(plan, weekly_run_days_max=3) == []


def test_three_day_quality_stacking_ignores_full_frequency_runner():
    weeks = [_week(
        week_index=1,
        week_start="2026-05-19",
        km_high=70,
        sessions=[
            {"type": "long_run", "distance_km": 26, "purpose": "同次长跑内含10km马配"},
            {"type": "tempo", "duration_min": 30},
        ],
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    assert check_three_day_quality_stacking(plan, weekly_run_days_max=5) == []


def test_injury_return_volume_ceiling_catches_peak_past_history():
    weeks = [_week(
        week_index=1,
        week_start="2026-05-19",
        km_high=86,
        sessions=[{"type": "long_run", "distance_km": 30}],
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    violations = check_injury_return_volume_ceiling(
        plan,
        injuries=["knee"],
        training_history_summary={
            "peak_weekly_km_in_window": 58,
            "training_gaps": [
                {"reason": "knee injury (patellar tendinitis) + PT rehab"}
            ],
        },
    )

    assert len(violations) == 1
    assert violations[0].rule == "injury_return_volume_ceiling"
    assert violations[0].severity == "error"
    assert violations[0].details["historical_peak_weekly_km"] == 58


def test_injury_return_volume_ceiling_allows_small_buffer():
    weeks = [_week(
        week_index=1,
        week_start="2026-05-19",
        km_high=65,
        sessions=[{"type": "long_run", "distance_km": 24}],
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    assert check_injury_return_volume_ceiling(
        plan,
        injuries=["knee"],
        training_history_summary={
            "peak_weekly_km_in_window": 58,
            "training_gaps": [{"reason": "patellar tendinitis rehab"}],
        },
    ) == []


def test_injury_return_peak_exception_count_warns_when_repeated_28k_rehearsal():
    plan = MasterPlan.model_validate(_plan_with_weeks([
        _week(week_index=1, week_start="2026-09-07", km_high=64,
              sessions=[{"type": "long_run", "distance_km": 28}]),
        _week(week_index=2, week_start="2026-09-14", km_high=65,
              sessions=[{"type": "long_run", "distance_km": 28}]),
        _week(week_index=3, week_start="2026-09-21", km_high=42,
              is_recovery_week=True,
              sessions=[{"type": "long_run", "distance_km": 16}]),
    ]))

    violations = check_injury_return_peak_exception_count(
        plan,
        injuries=["knee"],
        training_history_summary={
            "peak_weekly_km_in_window": 58,
            "training_gaps": [{"reason": "patellar tendinitis rehab"}],
        },
    )

    assert len(violations) == 1
    assert violations[0].rule == "injury_return_peak_exception_count"
    assert violations[0].severity == "warning"
    assert violations[0].details["week_indices"] == [1, 2]


def test_injury_return_peak_exception_count_allows_single_high_week():
    plan = MasterPlan.model_validate(_plan_with_weeks([
        _week(week_index=1, week_start="2026-09-07", km_high=62,
              sessions=[{"type": "long_run", "distance_km": 22}]),
        _week(week_index=2, week_start="2026-09-14", km_high=65,
              sessions=[{"type": "long_run", "distance_km": 28}]),
    ]))

    assert check_injury_return_peak_exception_count(
        plan,
        injuries=["knee"],
        training_history_summary={
            "peak_weekly_km_in_window": 58,
            "training_gaps": [{"reason": "patellar tendinitis rehab"}],
        },
    ) == []


def test_injury_return_peak_exception_count_allows_64k_adaptation_before_28k_rehearsal():
    plan = MasterPlan.model_validate(_plan_with_weeks([
        _week(week_index=1, week_start="2026-09-07", km_high=64,
              sessions=[{"type": "long_run", "distance_km": 22}]),
        _week(week_index=2, week_start="2026-09-14", km_high=65,
              sessions=[{"type": "long_run", "distance_km": 28}]),
    ]))

    assert check_injury_return_peak_exception_count(
        plan,
        injuries=["knee"],
        training_history_summary={
            "peak_weekly_km_in_window": 58,
            "training_gaps": [{"reason": "patellar tendinitis rehab"}],
        },
    ) == []


def test_injury_return_peak_exception_count_warns_high_week_after_28k_rehearsal():
    plan = MasterPlan.model_validate(_plan_with_weeks([
        _week(week_index=1, week_start="2026-09-07", km_high=65,
              sessions=[{"type": "long_run", "distance_km": 28}]),
        _week(week_index=2, week_start="2026-09-14", km_high=64,
              sessions=[{"type": "long_run", "distance_km": 22}]),
    ]))

    violations = check_injury_return_peak_exception_count(
        plan,
        injuries=["knee"],
        training_history_summary={
            "peak_weekly_km_in_window": 58,
            "training_gaps": [{"reason": "patellar tendinitis rehab"}],
        },
    )

    assert len(violations) == 1
    assert violations[0].rule == "injury_return_peak_exception_count"


def test_injury_return_volume_ceiling_ignores_chronic_controlled_history():
    weeks = [_week(
        week_index=1,
        week_start="2026-05-19",
        km_high=92,
        sessions=[{"type": "long_run", "distance_km": 32}],
    )]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    assert check_injury_return_volume_ceiling(
        plan,
        injuries=["右跟腱止点肌腱病（慢性，可控；中高强度时无痛）"],
        training_history_summary={
            "peak_weekly_km_in_window": 78,
            "training_gaps": [
                {"reason": "post-race recovery from 3 consecutive marathons"}
            ],
        },
    ) == []


def test_long_run_share_threshold_does_not_relax_for_chronic_controlled_history():
    assert _long_run_share_threshold(
        target_race={"distance": "fm"},
        weekly_run_days_max=6,
        injuries=["右跟腱止点肌腱病（慢性，可控；中高强度时无痛）"],
        training_history_summary={
            "peak_weekly_km_in_window": 78,
            "training_gaps": [
                {"reason": "post-race recovery from 3 consecutive marathons"}
            ],
        },
    ) == 0.35


def test_long_run_share_threshold_relaxes_for_3day_runner():
    assert _long_run_share_threshold(
        target_race={"distance": "fm"},
        weekly_run_days_max=3,
        injuries=None,
        training_history_summary=None,
    ) == 0.50


def test_long_run_share_threshold_relaxes_for_injury_return():
    assert _long_run_share_threshold(
        target_race={"distance": "fm"},
        weekly_run_days_max=5,
        injuries=["knee"],
        training_history_summary={
            "training_gaps": [{"reason": "knee injury + PT rehab"}],
        },
    ) == 0.45


def test_long_run_share_threshold_relaxes_for_low_history_fm_cap():
    assert _long_run_share_threshold(
        target_race={"distance": "fm"},
        weekly_run_days_max=5,
        injuries=None,
        training_history_summary={"peak_weekly_km_in_window": 58},
    ) == 0.50


def test_long_run_share_threshold_keeps_35pct_for_high_history_fm():
    assert _long_run_share_threshold(
        target_race={"distance": "fm"},
        weekly_run_days_max=6,
        injuries=None,
        training_history_summary={"peak_weekly_km_in_window": 78},
    ) == 0.35


def test_long_run_share_threshold_keeps_35pct_for_low_history_hm():
    assert _long_run_share_threshold(
        target_race={"distance": "hm"},
        weekly_run_days_max=6,
        injuries=None,
        training_history_summary={"peak_weekly_km_in_window": 58},
    ) == 0.35


# ---------------------------------------------------------------------------
# hard_session_spacing
# ---------------------------------------------------------------------------


def test_hard_session_spacing_two_hards_passes():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 22},
        {"type": "threshold", "duration_min": 30},
        {"type": "tempo", "duration_min": 25},  # 2 hards
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    assert check_hard_session_spacing(plan) == []


def test_hard_session_spacing_three_hards_fails():
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "interval", "duration_min": 30},
        {"type": "threshold", "duration_min": 30},
        {"type": "race_pace", "distance_km": 12},  # 3 hards
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_hard_session_spacing(plan)
    assert len(violations) == 1
    assert violations[0].severity == "error"
    assert violations[0].details["limit"] == 2
    assert set(violations[0].details["hard_session_types"]) == {
        "interval", "threshold", "race_pace",
    }


def test_hard_session_spacing_long_run_doesnt_count_as_hard():
    """long_run is in the skeleton but NOT in _HARD_SESSION_TYPES."""
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "long_run", "distance_km": 30},
        {"type": "long_run", "distance_km": 22},
        {"type": "long_run", "distance_km": 18},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    assert check_hard_session_spacing(plan) == []


def test_hard_session_spacing_empty_skeleton_is_noop():
    plan = MasterPlan.model_validate(_base_plan_dict())
    assert check_hard_session_spacing(plan) == []


# ---------------------------------------------------------------------------
# Orchestrator integration: Batch B fires via run_master_rule_filter
# ---------------------------------------------------------------------------


def test_orchestrator_runs_batch_b_rules():
    """Plan with 3 hards in one week should produce hard_session_spacing error."""
    plan_dict = _base_plan_dict()
    plan_dict["weekly_key_sessions"] = [_week(
        week_index=1, week_start="2026-05-19",
        sessions=[
            {"type": "interval", "duration_min": 30},
            {"type": "threshold", "duration_min": 30},
            {"type": "race_pace", "distance_km": 12},
        ],
    )]
    report = run_master_rule_filter(plan_dict, **_kwargs_full())
    rules_hit = {v.rule for v in report.violations}
    assert "hard_session_spacing" in rules_hit


# ---------------------------------------------------------------------------
# Codex-review round-2 regressions (P0 + P1 fixes)
# ---------------------------------------------------------------------------


def test_weekly_volume_ramp_post_recovery_rebound_allowed():
    """60 → 42 (recovery) → 62 must NOT trigger weekly_volume_ramp (P0 #1).

    The rule now compares to the most recent non-deload week, so a normal
    post-recovery rebound (+3% vs the previous load week) is not flagged
    as a 1.48x ramp.
    """
    weeks = [
        _week(week_index=1, week_start="2026-05-19", km_high=60),  # load week
        _week(week_index=2, week_start="2026-05-26", km_high=42, is_recovery_week=True),
        _week(week_index=3, week_start="2026-06-02", km_high=62),  # rebound: +3% vs week 1
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    assert check_weekly_volume_ramp(plan) == []


def test_weekly_volume_ramp_still_catches_jump_past_deload():
    """60 → 42 (recovery) → 72 IS a violation (+20% vs the last load week)."""
    weeks = [
        _week(week_index=1, week_start="2026-05-19", km_high=60),
        _week(week_index=2, week_start="2026-05-26", km_high=42, is_recovery_week=True),
        _week(week_index=3, week_start="2026-06-02", km_high=72),  # 1.20x vs week 1
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_weekly_volume_ramp(plan)
    assert len(violations) == 1
    assert violations[0].details["prev_load_week_index"] == 1


def test_weekly_volume_ramp_allows_small_integer_rounding_boundary():
    """28 -> 31 is 1.107x, but only 0.2km above the 10% cap."""
    weeks = [
        _week(week_index=1, week_start="2026-05-19", km_high=28),
        _week(week_index=2, week_start="2026-05-26", km_high=31),
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    assert check_weekly_volume_ramp(plan) == []


def test_weekly_volume_ramp_catches_32k_peak_jump_past_recovery():
    """Real S1 retry guard: 78 -> recovery -> 92 is still a 1.18x load jump."""
    weeks = [
        _week(week_index=11, week_start="2026-07-06", km_high=78),
        _week(week_index=12, week_start="2026-07-13", km_high=48, is_recovery_week=True),
        _week(week_index=13, week_start="2026-07-20", km_high=92),
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_weekly_volume_ramp(plan)
    assert len(violations) == 1
    assert violations[0].details == {
        "prev_load_week_index": 11,
        "curr_week_index": 13,
        "prev_load_km_high": 78.0,
        "curr_km_high": 92.0,
        "ratio": 1.179,
        "max_ratio": 1.1,
        "allowed_km_high_with_rounding": 86.8,
    }


def test_peak_before_race_5k_allows_3_to_7_day_window():
    """5K race: peak ending 5 days before race must pass (3-5 day taper window).

    Pre-fix this would have failed the universal 7-21 day rule.
    """
    from coach.graphs.generation.master_rule_filter import check_peak_before_race
    plan_dict = _base_plan_dict()
    plan_dict["phases"][2]["end_date"] = "2026-10-14"  # peak ends 5 days before race 10-19
    plan_dict["phases"][3]["start_date"] = "2026-10-15"  # taper covers 4 days
    plan = MasterPlan.model_validate(plan_dict)
    violations = check_peak_before_race(plan, target_race={"distance": "5k"})
    assert violations == []


def test_peak_before_race_5k_rejects_14_day_window():
    """5K race: peak ending 14 days before race is too far out (5K cap is 7)."""
    from coach.graphs.generation.master_rule_filter import check_peak_before_race
    plan_dict = _base_plan_dict()
    # _base_plan_dict has peak ending 10-02, race 10-19 = 17 days → too far for 5K
    plan = MasterPlan.model_validate(plan_dict)
    violations = check_peak_before_race(plan, target_race={"distance": "5k"})
    assert len(violations) == 1
    assert violations[0].details["max_days"] == 7


def test_peak_before_race_hm_allows_7_to_14_days():
    """HM race: peak ending 14 days before race (1-week taper boundary)."""
    from coach.graphs.generation.master_rule_filter import check_peak_before_race
    plan_dict = _base_plan_dict()
    # Default peak ends 10-02, race 10-19 = 17 days
    plan_dict["phases"][2]["end_date"] = "2026-10-05"  # 14 days before race
    plan_dict["phases"][3]["start_date"] = "2026-10-06"
    plan = MasterPlan.model_validate(plan_dict)
    violations = check_peak_before_race(plan, target_race={"distance": "hm"})
    assert violations == []


def test_peak_before_race_default_when_no_distance():
    """Missing target_race kwarg falls back to permissive 3-21 day window."""
    from coach.graphs.generation.master_rule_filter import check_peak_before_race
    plan = MasterPlan.model_validate(_base_plan_dict())
    # Peak ends 10-02, race 10-19 = 17 days → within default 3-21 window
    violations = check_peak_before_race(plan, target_race=None)
    assert violations == []


def test_weekly_key_sessions_coverage_truncated_plan_fails():
    """20-week plan span with only 8 weeks emitted must fail (P1 #2)."""
    plan_dict = _base_plan_dict()  # 153-day plan = ~22 weeks
    plan_dict["weekly_key_sessions"] = [
        _week(week_index=i, week_start="2026-05-19", sessions=[
            {"type": "long_run", "distance_km": 18},
        ])
        for i in range(1, 9)  # only 8 weeks
    ]
    plan = MasterPlan.model_validate(plan_dict)
    violations = check_weekly_key_sessions_present(plan)
    coverage = [v for v in violations if "weeks but plan span" in v.message]
    assert len(coverage) == 1
    assert coverage[0].details["actual_weeks"] == 8
    assert coverage[0].details["expected_weeks"] >= 21


def test_weekly_key_sessions_coverage_nonsequential_index_fails():
    """week_index 1, 3, 4, ... fails the sequential check."""
    weeks = [
        _week(week_index=1, week_start="2026-05-19"),
        _week(week_index=3, week_start="2026-05-26"),  # gap!
    ]
    plan_dict = _plan_with_weeks(weeks)
    plan = MasterPlan.model_validate(plan_dict)
    violations = check_weekly_key_sessions_present(plan)
    seq = [v for v in violations if "expected" in v.message and "sequential" in v.message]
    assert len(seq) == 1


def test_key_session_density_race_week_with_extras_fails():
    """[race, threshold, tempo, interval] in one week must fail (P1 #3)."""
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "race", "distance_km": 42.2},
        {"type": "threshold", "duration_min": 30},
        {"type": "tempo", "duration_min": 25},
        {"type": "interval", "duration_min": 35},
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_key_session_density(plan, weekly_run_days_max=5)
    assert len(violations) == 1
    # And hard_session_spacing should also fail (3 hards in same week)
    spacing = check_hard_session_spacing(plan)
    assert len(spacing) == 1


def test_target_distance_long_run_early_build_doesnt_satisfy_peak(monkeypatch):
    """28km long_run in a build-phase week (ph1) doesn't satisfy peak rule (P1 #4)."""
    plan_dict = _base_plan_dict()
    plan_dict["weekly_key_sessions"] = [
        _week(week_index=1, week_start="2026-05-19", phase_id="ph1",  # base phase
              sessions=[{"type": "long_run", "distance_km": 30}]),  # plenty
    ]
    plan = MasterPlan.model_validate(plan_dict)
    violations = check_target_distance_long_run(plan, target_race={"distance": "fm"})
    # peak phase is ph3; no long_run in ph3 → violation
    assert len(violations) == 1
    assert "no long_run session" in violations[0].message


def test_hard_session_spacing_time_trial_counts_as_hard():
    """time_trial + tune_up_race now count as hard sessions (P1 #5)."""
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "threshold", "duration_min": 30},
        {"type": "tempo", "duration_min": 25},
        {"type": "time_trial", "distance_km": 8},  # 3rd hard
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_hard_session_spacing(plan)
    same_week = [v for v in violations if "per week" in v.message]
    assert len(same_week) == 1


def test_hard_session_spacing_5_consecutive_hard_weeks_fails():
    """5 consecutive non-deload weeks with ≥ 2 hard sessions each fails (P1 #5)."""
    sessions = [
        {"type": "threshold", "duration_min": 30},
        {"type": "tempo", "duration_min": 25},
    ]
    weeks = [
        _week(week_index=i, week_start=f"2026-05-{19 + (i - 1) * 7:02d}",
              sessions=sessions)
        for i in range(1, 6)  # 5 weeks, no deload
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_hard_session_spacing(plan)
    streak = [v for v in violations if "consecutive non-deload weeks" in v.message]
    assert len(streak) == 1
    assert streak[0].details["streak_length"] == 5


def test_hard_session_spacing_deload_resets_streak():
    """3 hard weeks + 1 deload + 3 hard weeks must NOT fail (streak resets)."""
    sessions_hard = [
        {"type": "threshold", "duration_min": 30},
        {"type": "tempo", "duration_min": 25},
    ]
    sessions_easy = [{"type": "long_run", "distance_km": 18}]
    weeks = [
        _week(week_index=1, week_start="2026-05-19", sessions=sessions_hard),
        _week(week_index=2, week_start="2026-05-26", sessions=sessions_hard),
        _week(week_index=3, week_start="2026-06-02", sessions=sessions_hard),
        _week(week_index=4, week_start="2026-06-09",
              sessions=sessions_easy, is_recovery_week=True),
        _week(week_index=5, week_start="2026-06-16", sessions=sessions_hard),
        _week(week_index=6, week_start="2026-06-23", sessions=sessions_hard),
        _week(week_index=7, week_start="2026-06-30", sessions=sessions_hard),
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_hard_session_spacing(plan)
    streak = [v for v in violations if "consecutive non-deload weeks" in v.message]
    assert streak == []


def test_taper_volume_drop_compares_against_actual_peak_not_sharpener():
    """A lower pre-taper sharpener week should not make taper look invalid.

    Regression from real S1 eval: 84km peak → 48km recovery → 66km sharpener
    → 54km first taper. Comparing 54 to 66 says -18% and falsely blocks;
    comparing to the actual 84km peak gives -36%, which is a valid taper.
    """
    weeks = [
        _week(week_index=1, week_start="2026-09-14", sessions=[
            {"type": "long_run", "distance_km": 32},
            {"type": "race_pace", "distance_km": 22},
    ], km_high=84),
        _week(week_index=2, week_start="2026-09-21", sessions=[
            {"type": "long_run", "distance_km": 18},
    ], km_high=48, is_recovery_week=True),
        _week(week_index=3, week_start="2026-09-28", sessions=[
            {"type": "long_run", "distance_km": 26},
            {"type": "race_pace", "distance_km": 14},
    ], km_high=66),
        _week(week_index=4, week_start="2026-10-05", sessions=[
            {"type": "long_run", "distance_km": 18},
    ], km_high=54, is_taper_week=True),
    ]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))

    assert check_taper_volume_drop(plan) == []


def test_key_session_density_race_plus_one_extra_fails():
    """Race-week with ANY extra session must fail, even when under the
    density limit (codex round-2 P1 #3 follow-up)."""
    weeks = [_week(week_index=1, week_start="2026-05-19", sessions=[
        {"type": "race", "distance_km": 42.2},
        {"type": "threshold", "duration_min": 30},  # extra — still under limit but wrong
    ])]
    plan = MasterPlan.model_validate(_plan_with_weeks(weeks))
    violations = check_key_session_density(plan, weekly_run_days_max=5)
    assert len(violations) == 1
    msg = violations[0].message
    assert "race weeks must contain only the race" in msg


def test_identify_peak_phase_bare_比赛_not_picked_as_peak():
    """Bare 比赛 phase should NOT be selected as peak (codex round-2 P1 #4
    follow-up). Verifies _is_non_peak_phase now classifies it correctly."""
    from coach.graphs.generation.master_rule_filter import (
        _identify_peak_phase,
        _is_non_peak_phase,
    )
    assert _is_non_peak_phase("比赛") is True
    # Peak-prep override still works:
    assert _is_non_peak_phase("比赛峰值期") is False
    assert _is_non_peak_phase("比赛准备期") is False
    assert _is_non_peak_phase("race prep") is False
    # 比赛 phase included in plan — peak should be the prep phase, not 比赛
    plan_dict = _base_plan_dict()
    plan_dict["phases"] = [
        {"id": "ph_base", "name": "基础期",
         "start_date": "2026-05-19", "end_date": "2026-07-13",
         "focus": "base", "weekly_distance_km_low": 40,
         "weekly_distance_km_high": 50,
         "key_session_types": ["long_run"], "milestone_ids": []},
        {"id": "ph_prep", "name": "比赛准备期",
         "start_date": "2026-07-14", "end_date": "2026-10-02",
         "focus": "peak", "weekly_distance_km_low": 60,
         "weekly_distance_km_high": 70,
         "key_session_types": ["race_pace"], "milestone_ids": []},
        {"id": "ph_taper", "name": "减量期",
         "start_date": "2026-10-03", "end_date": "2026-10-14",
         "focus": "taper", "weekly_distance_km_low": 30,
         "weekly_distance_km_high": 40,
         "key_session_types": ["interval"], "milestone_ids": []},
        {"id": "ph_race", "name": "比赛",  # bare 比赛
         "start_date": "2026-10-15", "end_date": "2026-10-19",
         "focus": "race", "weekly_distance_km_low": 10,
         "weekly_distance_km_high": 15,
         "key_session_types": ["race"], "milestone_ids": ["m1"]},
    ]
    plan = MasterPlan.model_validate(plan_dict)
    # Peak should be ph_prep (比赛准备期), NOT ph_race (比赛)
    assert _identify_peak_phase(plan) == "ph_prep"


def test_peak_phase_type_overrides_race_keyword_in_name():
    """A structured peak phase named 比赛峰值期 must be the peak, not skipped
    because the Chinese name contains 比赛."""
    from coach.graphs.generation.master_rule_filter import (
        _identify_peak_phase,
        check_peak_before_race,
        check_target_distance_long_run,
    )

    plan_dict = _base_plan_dict()
    plan_dict["phases"] = [
        {"id": "ph_base", "name": "有氧巩固期", "phase_type": "base",
         "start_date": "2026-05-25", "end_date": "2026-06-21",
         "focus": "base", "weekly_distance_km_low": 30,
         "weekly_distance_km_high": 52,
         "key_session_types": ["long_run"], "milestone_ids": []},
        {"id": "ph_build", "name": "5K专项建设期", "phase_type": "build",
         "start_date": "2026-07-20", "end_date": "2026-08-30",
         "focus": "build", "weekly_distance_km_low": 36,
         "weekly_distance_km_high": 55,
         "key_session_types": ["vo2max", "long_run"], "milestone_ids": []},
        {"id": "ph_peak", "name": "比赛峰值期", "phase_type": "peak",
         "start_date": "2026-08-31", "end_date": "2026-09-13",
         "focus": "peak", "weekly_distance_km_low": 38,
         "weekly_distance_km_high": 55,
         "key_session_types": ["interval", "long_run"], "milestone_ids": []},
        {"id": "ph_taper", "name": "比赛周减量期", "phase_type": "taper",
         "start_date": "2026-09-14", "end_date": "2026-09-20",
         "focus": "taper", "weekly_distance_km_low": 28,
         "weekly_distance_km_high": 32,
         "key_session_types": ["race"], "milestone_ids": ["m1"]},
    ]
    plan_dict["start_date"] = "2026-05-25"
    plan_dict["end_date"] = "2026-09-20"
    plan_dict["milestones"] = [{
        "id": "m1", "type": "race", "date": "2026-09-20",
        "phase_id": "ph_taper", "target": "A<18:00",
    }]
    plan_dict["weekly_key_sessions"] = [_week(
        week_index=1, week_start="2026-09-07", phase_id="ph_peak",
        sessions=[{"type": "long_run", "distance_km": 8}],
    )]
    plan = MasterPlan.model_validate(plan_dict)

    assert _identify_peak_phase(plan) == "ph_peak"
    assert check_peak_before_race(plan, target_race={"distance": "5k"}) == []
    assert check_target_distance_long_run(plan, target_race={"distance": "5k"}) == []


def test_target_distance_long_run_with_bare_比赛_phase():
    """End-to-end: a valid plan with a 比赛 race phase and long_run in
    赛前期 must pass target_distance_long_run (codex P1 #4 follow-up)."""
    plan_dict = _base_plan_dict()
    plan_dict["phases"] = [
        {"id": "ph_base", "name": "基础期",
         "start_date": "2026-05-19", "end_date": "2026-07-13",
         "focus": "base", "weekly_distance_km_low": 40,
         "weekly_distance_km_high": 50,
         "key_session_types": ["long_run"], "milestone_ids": []},
        {"id": "ph_prep", "name": "赛前期",
         "start_date": "2026-07-14", "end_date": "2026-10-02",
         "focus": "peak", "weekly_distance_km_low": 60,
         "weekly_distance_km_high": 70,
         "key_session_types": ["race_pace"], "milestone_ids": []},
        {"id": "ph_taper", "name": "减量期",
         "start_date": "2026-10-03", "end_date": "2026-10-14",
         "focus": "taper", "weekly_distance_km_low": 30,
         "weekly_distance_km_high": 40,
         "key_session_types": ["interval"], "milestone_ids": []},
        {"id": "ph_race", "name": "比赛",
         "start_date": "2026-10-15", "end_date": "2026-10-19",
         "focus": "race", "weekly_distance_km_low": 10,
         "weekly_distance_km_high": 15,
         "key_session_types": ["race"], "milestone_ids": ["m1"]},
    ]
    plan_dict["weekly_key_sessions"] = [_week(
        week_index=1, week_start="2026-09-15", phase_id="ph_prep",
        sessions=[{"type": "long_run", "distance_km": 30}],
    )]
    # Override plan end to fit the 1-week skeleton
    plan_dict["end_date"] = "2026-09-21"
    plan = MasterPlan.model_validate(plan_dict)
    violations = check_target_distance_long_run(plan, target_race={"distance": "fm"})
    # Peak phase is 赛前期 (ph_prep), long_run there is 30km > 28km threshold
    assert violations == []


# ---------------------------------------------------------------------------
# long_run_distance_share (Stage-1 Task 3)
# ---------------------------------------------------------------------------


def _peak_plan(long_km, week_high):
    return MasterPlan.model_validate({
        "plan_id": "x", "user_id": "u", "status": "draft", "goal_id": "g",
        "start_date": "2026-06-11", "end_date": "2026-10-18",
        "phases": [{"id": "peak1", "name": "赛前期", "start_date": "2026-09-07",
                    "end_date": "2026-10-04", "focus": "peak",
                    "weekly_distance_km_low": 70, "weekly_distance_km_high": week_high,
                    "key_session_types": ["长距离"], "milestone_ids": []}],
        "milestones": [],
        "weekly_key_sessions": [{
            "week_index": 1, "week_start": "2026-09-21", "phase_id": "peak1",
            "target_weekly_km_low": week_high - 4, "target_weekly_km_high": week_high,
            "key_sessions": [{"type": "long_run", "distance_km": long_km, "intensity": "z2"}],
            "is_recovery_week": False, "is_taper_week": False,
        }],
        "training_principles": [], "generated_by": "t", "version": 1,
        "created_at": "t", "updated_at": "t",
    })


def test_long_run_share_over_35pct_warns():
    v = check_long_run_distance_share(_peak_plan(long_km=32, week_high=80))  # 40%
    assert len(v) == 1
    assert v[0].rule == "long_run_distance_share"
    assert v[0].severity == "warning"


def test_long_run_share_under_35pct_ok():
    assert check_long_run_distance_share(_peak_plan(long_km=27, week_high=80)) == []  # 33.75%


def test_long_run_share_volume_capped_threshold_ok():
    assert check_long_run_distance_share(
        _peak_plan(long_km=28, week_high=60),
        max_share=0.50,
    ) == []


def test_long_run_share_volume_capped_threshold_still_warns_extreme_share():
    v = check_long_run_distance_share(
        _peak_plan(long_km=32, week_high=60),
        max_share=0.50,
    )
    assert len(v) == 1
    assert v[0].details["max_share_pct"] == 50.0


def test_long_run_share_can_collapse_volume_capped_repeated_warnings():
    plan = MasterPlan.model_validate({
        "plan_id": "x", "user_id": "u", "status": "draft", "goal_id": "g",
        "start_date": "2026-06-11", "end_date": "2026-10-18",
        "phases": [{"id": "peak1", "name": "赛前期", "start_date": "2026-09-07",
                    "end_date": "2026-10-04", "focus": "peak",
                    "weekly_distance_km_low": 40, "weekly_distance_km_high": 48,
                    "key_session_types": ["长距离"], "milestone_ids": []}],
        "milestones": [],
        "weekly_key_sessions": [
            {
                "week_index": 1, "week_start": "2026-09-07", "phase_id": "peak1",
                "target_weekly_km_low": 36, "target_weekly_km_high": 42,
                "key_sessions": [{"type": "long_run", "distance_km": 22, "intensity": "z2"}],
                "is_recovery_week": False, "is_taper_week": False,
            },
            {
                "week_index": 2, "week_start": "2026-09-14", "phase_id": "peak1",
                "target_weekly_km_low": 42, "target_weekly_km_high": 48,
                "key_sessions": [{"type": "long_run", "distance_km": 28, "intensity": "z2"}],
                "is_recovery_week": False, "is_taper_week": False,
            },
        ],
        "training_principles": [], "generated_by": "t", "version": 1,
        "created_at": "t", "updated_at": "t",
    })

    violations = check_long_run_distance_share(
        plan,
        max_share=0.50,
        collapse_warnings=True,
    )

    assert len(violations) == 1
    assert violations[0].details["week_index"] == 2
    assert violations[0].details["share_pct"] == 58.3


def test_run_master_rule_filter_collapses_three_day_long_run_share_warnings():
    plan_dict = _plan_with_weeks([
        _week(
            week_index=1,
            week_start="2026-09-07",
            km_low=36,
            km_high=42,
            sessions=[{"type": "long_run", "distance_km": 22, "intensity": "z2"}],
        ),
        _week(
            week_index=2,
            week_start="2026-09-14",
            km_low=42,
            km_high=48,
            sessions=[{"type": "long_run", "distance_km": 28, "intensity": "z2"}],
        ),
    ])

    report = run_master_rule_filter(
        plan_dict,
        target_race={"distance": "fm", "goal_time_s": 12600},
        weekly_run_days_max=3,
    )

    share_warnings = [
        v for v in report.violations if v.rule == "long_run_distance_share"
    ]
    assert len(share_warnings) == 1
    assert share_warnings[0].details["week_index"] == 2


def test_long_run_share_empty_skeleton_noop():
    plan = _peak_plan(long_km=32, week_high=80).model_copy(update={"weekly_key_sessions": []})
    assert check_long_run_distance_share(plan) == []


def test_orchestrator_back_compat_empty_weekly_key_sessions():
    """Existing plans with empty weekly_key_sessions still pass all rules."""
    plan_dict = _base_plan_dict()
    # weekly_key_sessions default = [] via schema
    report = run_master_rule_filter(plan_dict, **_kwargs_full())
    # Batch B rules should NOT fire for empty skeleton
    batch_b_rules = {
        "weekly_key_sessions_present", "weekly_volume_ramp",
        "taper_volume_drop", "target_distance_long_run",
        "key_session_density", "hard_session_spacing",
    }
    assert not any(v.rule in batch_b_rules for v in report.violations)
    assert report.ok


# ---------------------------------------------------------------------------
# Season-continuity: completed lead-in phase + active-plan-view exemption
#
# Regression for the false weekly_key_sessions_present coverage block: a
# continuity plan carries an already-completed leading phase (is_completed,
# NO weeks) on the calendar span, so plan.start_date sits BEFORE the first
# emitted (active) week. The coverage check must measure the ACTIVE span only,
# regardless of whether the LLM numbered the active weeks continuously from the
# season start (W9..) or restarted them at W1. _active_plan_view re-bases the
# weekly view to the first active week so the check sees the from-week-1 shape.
# ---------------------------------------------------------------------------


def _continuity_plan(*, number_weeks_from: int, n_active_weeks: int = 4) -> dict:
    """Plan with a 2-week completed base lead-in + ``n_active_weeks`` active weeks.

    completed base : 2026-06-15 → 2026-06-28 (is_completed, no weeks)
    active phase   : 2026-06-29 → 2026-06-29 + n_active_weeks*7 - 1
    plan span      : 2026-06-15 → active end (race day proxy)

    ``number_weeks_from`` controls how the active weeks are indexed:
      * 1 → the LLM restarted the active weeks at W1 (offset 0, the bug case)
      * 3 → the LLM numbered continuously from the season start (base = W1-2,
            so the active phase begins at W3)
    """
    from datetime import date as _date_cls
    from datetime import timedelta

    active_start = _date_cls.fromisoformat("2026-06-29")
    active_end = active_start + timedelta(days=n_active_weeks * 7 - 1)
    weeks = [
        _week(
            week_index=number_weeks_from + i,
            week_start=(active_start + timedelta(days=i * 7)).isoformat(),
            phase_id="ph_active",
            sessions=[{"type": "long_run", "distance_km": 18},
                      {"type": "threshold", "duration_min": 30}],
        )
        for i in range(n_active_weeks)
    ]
    return {
        "plan_id": "p1", "user_id": "u1", "status": "draft", "goal_id": "g1",
        "start_date": "2026-06-15",
        "end_date": active_end.isoformat(),
        "phases": [
            {
                "id": "ph_done", "name": "已完成基础期",
                "start_date": "2026-06-15", "end_date": "2026-06-28",
                "focus": "completed base", "weekly_distance_km_low": 40,
                "weekly_distance_km_high": 50, "key_session_types": [],
                "milestone_ids": [], "is_completed": True,
            },
            {
                "id": "ph_active", "name": "速度期",
                "start_date": "2026-06-29", "end_date": active_end.isoformat(),
                "focus": "active", "weekly_distance_km_low": 55,
                "weekly_distance_km_high": 65,
                "key_session_types": ["threshold"], "milestone_ids": [],
            },
        ],
        "milestones": [],
        "current_phase_id": "ph_active",
        "training_principles": ["80/20"],
        "generated_by": "test", "version": 1,
        "created_at": "2026-06-15T00:00:00Z",
        "updated_at": "2026-06-15T00:00:00Z",
        "weekly_key_sessions": weeks,
    }


def test_active_view_rebases_start_when_weeks_restart_at_w1():
    """Offset-0 case (LLM restarted active weeks at W1): start_date must shift to
    the first active week so the completed lead-in span is excluded."""
    plan = MasterPlan.model_validate(_continuity_plan(number_weeks_from=1))
    view = _active_plan_view(plan)
    assert view.start_date == "2026-06-29"  # re-based off the 06-15 completed start
    # indices unchanged (already 1..N)
    assert [w.week_index for w in sorted(view.weekly_key_sessions,
                                         key=lambda w: w.week_index)] == [1, 2, 3, 4]


def test_active_view_rebases_and_renumbers_when_weeks_continuous():
    """Continuous-numbering case (base = W1-2 → active starts at W3): subtract the
    offset so the active weeks read 1..N AND re-base start_date."""
    plan = MasterPlan.model_validate(_continuity_plan(number_weeks_from=3))
    view = _active_plan_view(plan)
    assert view.start_date == "2026-06-29"
    assert [w.week_index for w in sorted(view.weekly_key_sessions,
                                         key=lambda w: w.week_index)] == [1, 2, 3, 4]


def test_completed_lead_in_does_not_false_block_weekly_coverage():
    """The bug: weekly_key_sessions_present over-counted the completed lead-in's
    calendar span and reported a missing-weeks error. After re-basing, the active
    weeks fully cover the active span → no error (both numbering conventions)."""
    for number_from in (1, 3):
        plan = MasterPlan.model_validate(_continuity_plan(number_weeks_from=number_from))
        # Raw plan (no re-base) WOULD fire — documents what the bug looked like.
        raw = check_weekly_key_sessions_present(plan)
        assert any(v.rule == "weekly_key_sessions_present" for v in raw), (
            f"expected raw coverage to over-count for number_from={number_from}"
        )
        # Re-based active view → clean.
        view = _active_plan_view(plan)
        assert check_weekly_key_sessions_present(view) == []


def test_active_view_noop_without_completed_phase():
    """No is_completed phase → _active_plan_view returns the plan unchanged
    (backward compatible — existing plans are untouched)."""
    plan = MasterPlan.model_validate(_base_plan_dict())
    assert _active_plan_view(plan) is plan
