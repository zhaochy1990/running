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


def _pace_work_block(pace_low_s_km: int, distance_m: int, repeat: int = 1):
    """A single-step work block targeting a pace range.

    ``pace_low_s_km`` is the slower (numerically larger) bound; we set the
    faster bound 5 s/km quicker so the range is well-formed. Only the slow
    bound (``low``) drives the Z4-Z5 classifier.
    """
    return {
        "repeat": repeat,
        "steps": [
            {
                "step_kind": "work",
                "duration": {"kind": "distance_m", "value": distance_m},
                "target": {
                    "kind": "pace_s_km",
                    "low": float(pace_low_s_km),
                    "high": float(pace_low_s_km - 5),
                },
                "note": None,
                "hr_cap_bpm": None,
            }
        ],
    }


def _structured_run_session(
    date: str, blocks: list, *, distance_m: int, duration_s: int
):
    """A run session carrying a real NormalizedRunWorkout spec."""
    return {
        "date": date,
        "session_index": 0,
        "kind": "run",
        "summary": "structured run",
        "spec": {
            "schema": "run-workout/v1",
            "name": "structured run",
            "date": date,
            "note": None,
            "blocks": blocks,
        },
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


def test_weekly_target_volume_over_master_target_fails():
    plan = _plan_dict(
        [
            _minimal_run_session("2026-05-11", 28000),
            _minimal_run_session("2026-05-13", 26000),
            _minimal_run_session("2026-05-15", 26000),
            _rest_session("2026-05-16"),
        ]
    )

    report = run_rule_filter(plan, target_weekly_km=78.0)

    assert any(v.rule == "weekly_target_volume" for v in report.errors())


def test_weekly_target_volume_allows_rounding_tolerance():
    plan = _plan_dict(
        [
            _minimal_run_session("2026-05-11", 27000),
            _minimal_run_session("2026-05-13", 26000),
            _minimal_run_session("2026-05-15", 25900),
            _rest_session("2026-05-16"),
        ]
    )

    report = run_rule_filter(plan, target_weekly_km=78.0)

    assert not any(v.rule == "weekly_target_volume" for v in report.errors())


def test_weekly_target_volume_under_master_target_fails():
    plan = _plan_dict(
        [
            _minimal_run_session("2026-05-11", 26000),
            _minimal_run_session("2026-05-13", 25000),
            _minimal_run_session("2026-05-15", 25000),
            _rest_session("2026-05-16"),
        ]
    )

    report = run_rule_filter(plan, target_weekly_km=78.0)

    assert any(v.rule == "weekly_target_volume" for v in report.errors())


# ---------------------------------------------------------------------------
# Athlete-relative Z4-Z5 threshold (Stage-3a Task 0)
# ---------------------------------------------------------------------------


def test_fast_runner_mp_week_passes_with_athlete_threshold():
    """2:50-runner build week with ~25% MP work.

    MP steps run at ~242 s/km (4:02/km) are Z3 for this athlete, whose
    threshold pace is ~228 s/km (3:48/km). With an athlete-relative
    threshold the MP work is NOT counted as Z4-Z5, so the 80/20 rule passes.
    """
    # 12 km of MP @ 242 s/km = 2904 s of "tempo" work.
    mp_session = _structured_run_session(
        "2026-05-12",
        [_pace_work_block(pace_low_s_km=242, distance_m=12000)],
        distance_m=14000,
        duration_s=3600,
    )
    plan = _plan_dict(
        [
            _minimal_run_session("2026-05-11", 10000, 4000),  # easy
            mp_session,
            _minimal_run_session("2026-05-13", 10000, 4000),  # easy
            _rest_session("2026-05-14"),
            _rest_session("2026-05-15"),
            _rest_session("2026-05-16"),
            _rest_session("2026-05-17"),
        ]
    )
    # Total planned seconds = 3600 + 4000 + 4000 = 11600. MP work 2904 = 25%.

    # With the athlete threshold (228), MP@242 is slower-than-threshold → Z3,
    # not hot → 80/20 rule passes.
    report = run_rule_filter(plan, z45_pace_threshold_s_km=228.0)
    assert not any(v.rule == "intensity_distribution" for v in report.errors()), [
        v.message for v in report.errors()
    ]

    # Contrast: under the legacy 270 constant (no kwarg), the same MP work is
    # miscounted as Z4-Z5 and trips the cap — proving the fix bites.
    legacy = run_rule_filter(plan)
    assert any(v.rule == "intensity_distribution" for v in legacy.errors())


def test_vo2max_heavy_week_still_trips_with_athlete_threshold():
    """A genuine VO2max week still violates the 80/20 cap.

    Reps at ~215 s/km (3:35/km) are faster than the athlete's 228 s/km
    threshold → genuinely Z4-Z5 → counted as hot regardless of the relaxed
    threshold.
    """
    # 8 × 1000m @ 215 s/km = 8 * 215 = 1720 s of hot work.
    vo2_session = _structured_run_session(
        "2026-05-12",
        [_pace_work_block(pace_low_s_km=215, distance_m=1000, repeat=8)],
        distance_m=10000,
        duration_s=3000,
    )
    plan = _plan_dict(
        [
            _minimal_run_session("2026-05-11", 8000, 2000),  # easy
            vo2_session,
            _minimal_run_session("2026-05-13", 8000, 2000),  # easy
            _rest_session("2026-05-14"),
            _rest_session("2026-05-15"),
            _rest_session("2026-05-16"),
            _rest_session("2026-05-17"),
        ]
    )
    # Total planned seconds = 3000 + 2000 + 2000 = 7000. Hot 1720 = 24.6% > 20%.
    report = run_rule_filter(plan, z45_pace_threshold_s_km=228.0)
    assert any(v.rule == "intensity_distribution" for v in report.errors())
