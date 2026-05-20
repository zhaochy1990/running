"""Unit tests for S1 master plan rule_filter — see docs/coach-eval_S1.md § S1 L1 Rules.

Covers 6 rules total:
  - master_schema_validity, phase_count_min, peak_before_race (existing — smoke
    coverage here; deeper coverage in their dedicated cases inline below)
  - phase_duration_balance (new — Batch A)
  - season_window_fits          (new — Batch A)
  - goal_realism                (new — Batch A)
"""

from __future__ import annotations

from copy import deepcopy

from coach.graphs.generation.master_rule_filter import (
    check_goal_realism,
    check_phase_duration_balance,
    check_season_window_fits,
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
        "training_principles": ["80/20"],
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
    assert micro[0].details["days"] == 3


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
    """Phases exactly 14 days and 112 days are within range (inclusive)."""
    plan_dict = _base_plan_dict()
    # Replace phases with a 3-phase plan whose durations are exactly the
    # min and max bounds. Drop the race milestone to isolate this check
    # from peak_before_race (which we're not testing here).
    plan_dict["phases"] = [
        {
            "id": "ph1", "name": "base",
            "start_date": "2026-05-19", "end_date": "2026-06-02",  # 14 days
            "focus": "base", "weekly_distance_km_low": 40,
            "weekly_distance_km_high": 50,
            "key_session_types": ["long_run"], "milestone_ids": [],
        },
        {
            "id": "ph2", "name": "build",
            "start_date": "2026-06-03", "end_date": "2026-09-23",  # 112 days
            "focus": "build", "weekly_distance_km_low": 55,
            "weekly_distance_km_high": 65,
            "key_session_types": ["threshold"], "milestone_ids": [],
        },
        {
            "id": "ph3", "name": "peak",
            "start_date": "2026-09-24", "end_date": "2026-10-08",  # 14 days
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
