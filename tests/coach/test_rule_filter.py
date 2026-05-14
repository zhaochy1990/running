"""US-008 acceptance: rule_filter catches the 7 safety violations from plan §7.3."""

from __future__ import annotations

from coach.graphs.generation.rule_filter import (
    RuleFilterReport,
    RuleViolation,
    run_rule_filter,
)


# ---------------------------------------------------------------------------
# Plan dict builders
# ---------------------------------------------------------------------------


def _minimal_run_session(date: str, distance_m: int = 8000, duration_s: int = 2700):
    return {
        "date": date,
        "session_index": 0,
        "kind": "run",
        "summary": "easy run",
        "spec": None,
        "notes_md": None,
        "total_distance_m": distance_m,
        "total_duration_s": duration_s,
    }


def _rest_session(date: str):
    return {
        "date": date,
        "session_index": 0,
        "kind": "rest",
        "summary": "完全休息",
        "spec": None,
        "notes_md": None,
        "total_distance_m": None,
        "total_duration_s": None,
    }


def _plan_dict(sessions, *, folder="2026-05-11_05-17(W1)") -> dict:
    return {
        "schema": "weekly-plan/v1",
        "week_folder": folder,
        "sessions": sessions,
        "nutrition": [],
    }


# ---------------------------------------------------------------------------
# Acceptance
# ---------------------------------------------------------------------------


def test_clean_plan_passes():
    plan = _plan_dict(
        [
            _minimal_run_session("2026-05-11", 8000, 2700),
            _minimal_run_session("2026-05-12", 10000, 3300),
            _minimal_run_session("2026-05-13", 6000, 2100),
            _minimal_run_session("2026-05-14", 12000, 3900),
            _minimal_run_session("2026-05-15", 0, 0),  # will count zero
            _rest_session("2026-05-16"),
            _rest_session("2026-05-17"),
        ]
    )
    report = run_rule_filter(plan, prev_week_km=35.0)
    assert report.ok, [v.rule for v in report.errors()]


def test_weekly_progression_jumps_30_percent_fails():
    plan = _plan_dict(
        [_minimal_run_session(f"2026-05-1{i}", 10000) for i in range(1, 8)]
        + [_rest_session("2026-05-17")]
    )
    report = run_rule_filter(plan, prev_week_km=40.0)  # 70 km vs prev 40 km = 1.75x
    assert not report.ok
    assert any(v.rule == "weekly_progression" for v in report.errors())


def test_long_run_share_over_35_percent_fails():
    plan = _plan_dict(
        [
            _minimal_run_session("2026-05-11", 5000),
            _minimal_run_session("2026-05-12", 5000),
            _minimal_run_session("2026-05-13", 30000),  # 75% of total — too much
            _rest_session("2026-05-14"),
            _rest_session("2026-05-15"),
            _rest_session("2026-05-16"),
            _rest_session("2026-05-17"),
        ]
    )
    report = run_rule_filter(plan)
    assert any(v.rule == "long_run_share" for v in report.errors())


def test_rest_days_missing_fails():
    plan = _plan_dict(
        [_minimal_run_session(f"2026-05-{day:02d}", 5000) for day in range(11, 18)]
    )
    report = run_rule_filter(plan)
    assert any(v.rule == "rest_days" for v in report.errors())


def test_schema_failure_short_circuits_other_rules():
    plan = {"schema": "weekly-plan/v1", "week_folder": "x", "sessions": "not-a-list"}
    report = run_rule_filter(plan)
    # Only the schema rule should fire — others can't run on a parse failure
    assert any(v.rule == "schema_validity" for v in report.errors())
    rules_triggered = {v.rule for v in report.errors()}
    assert rules_triggered == {"schema_validity"}


def test_ctl_ramp_excessive_volume_fails():
    # 5 × 1h-runs = 5h × 100 TSS = 500 TSS / 42 ≈ 12 TSS/week CTL ramp
    plan = _plan_dict(
        [_minimal_run_session(f"2026-05-1{i}", 10000, 3600) for i in range(1, 6)]
        + [_rest_session("2026-05-16"), _rest_session("2026-05-17")]
    )
    report = run_rule_filter(plan, prev_ctl=40.0)
    assert any(v.rule == "ctl_ramp" for v in report.errors())


def test_injury_conflict_squat_for_knee_pain_fails():
    plan = _plan_dict(
        [
            {
                "date": "2026-05-11",
                "session_index": 0,
                "kind": "strength",
                "summary": "下肢力量",
                "spec": {
                    "name": "下肢力量",
                    "date": "2026-05-11",
                    "exercises": [
                        {
                            "canonical_id": "T1336",
                            "display_name": "哑铃高脚杯深蹲",
                            "sets": 3,
                            "target_kind": "reps",
                            "target_value": 12,
                            "rest_seconds": 45,
                            "note": None,
                            "provider_id": "T1336",
                        }
                    ],
                    "note": None,
                },
                "notes_md": None,
                "total_distance_m": None,
                "total_duration_s": 2400,
            },
            _rest_session("2026-05-12"),
        ]
    )
    report = run_rule_filter(plan, injuries=["knee"])
    assert any(v.rule == "injury_conflict" for v in report.errors())


def test_no_prev_week_km_skips_progression_rule():
    plan = _plan_dict([_minimal_run_session("2026-05-11", 50000)])
    report = run_rule_filter(plan, prev_week_km=None)
    # Progression rule doesn't fire because we have no baseline
    assert not any(v.rule == "weekly_progression" for v in report.errors())
