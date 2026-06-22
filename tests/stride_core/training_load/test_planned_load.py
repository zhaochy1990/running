"""Tests for planned-run-workout load estimation.

`estimate_planned_run_load` projects a STRIDE training_dose (TSS-scaled,
1h @ threshold = 100) from a *planned* `NormalizedRunWorkout` — no timeseries,
only per-step pace/HR targets and durations. It must land on the same scale as
the actual `_compute_external_tss`, which the alignment test below pins down.
"""

from __future__ import annotations

from datetime import date

import pytest

from stride_core.training_load.core import (
    _compute_external_tss,
    estimate_planned_run_load,
)
from stride_core.training_load.types import (
    ActivityLoadInput,
    ActivitySample,
    CalibrationSnapshot,
)
from stride_core.workout_spec import (
    Duration,
    NormalizedRunWorkout,
    StepKind,
    Target,
    WorkoutBlock,
    WorkoutStep,
)

# threshold_speed 4.0 m/s → threshold pace 250 s/km (4:10/km)
THRESHOLD_SPEED = 4.0
THRESHOLD_PACE = 1000.0 / THRESHOLD_SPEED  # 250 s/km
THRESHOLD_HR = 170.0
RHR = 50.0


def _workout(*blocks: WorkoutBlock) -> NormalizedRunWorkout:
    return NormalizedRunWorkout(name="t", date="2026-05-01", blocks=tuple(blocks))


def _work_step(duration: Duration, target: Target, kind: StepKind = StepKind.WORK) -> WorkoutStep:
    return WorkoutStep(step_kind=kind, duration=duration, target=target)


def _estimate(workout: NormalizedRunWorkout, **kw) -> float | None:
    return estimate_planned_run_load(
        workout,
        threshold_speed_mps=kw.get("threshold_speed_mps", THRESHOLD_SPEED),
        threshold_hr=kw.get("threshold_hr", THRESHOLD_HR),
        rhr=kw.get("rhr", RHR),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Steady runs
# ─────────────────────────────────────────────────────────────────────────────


def test_steady_run_at_threshold_pace_is_100():
    # 60 min exactly at threshold pace → IF = 1.0 → dose = 100.
    wo = _workout(
        WorkoutBlock(steps=(
            _work_step(Duration.of_time_min(60), Target.pace_range_s_km(THRESHOLD_PACE, THRESHOLD_PACE)),
        ))
    )
    assert _estimate(wo) == pytest.approx(100.0, abs=0.5)


def test_steady_easy_run_below_threshold():
    # speed 3.12 m/s (IF 0.78) → pace ≈ 320.5 s/km; 60 min → 0.78² * 100 ≈ 60.8.
    pace = 1000.0 / (THRESHOLD_SPEED * 0.78)
    wo = _workout(
        WorkoutBlock(steps=(
            _work_step(Duration.of_time_min(60), Target.pace_range_s_km(pace, pace)),
        ))
    )
    assert _estimate(wo) == pytest.approx(0.78 ** 2 * 100.0, abs=1.0)


def test_steady_run_by_hr_target_uses_hr_fallback():
    # HR mid 110, rhr 50, threshold_hr 170 → IF = (110-50)/(170-50) = 0.5.
    # 30 min → (30/60) * 0.25 * 100 = 12.5.
    wo = _workout(
        WorkoutBlock(steps=(
            _work_step(Duration.of_time_min(30), Target.hr_range_bpm(105, 115)),
        ))
    )
    assert _estimate(wo) == pytest.approx(12.5, abs=0.3)


def test_pace_target_preferred_over_hr_when_both_present():
    # Pace gives IF 1.0; an hr_cap of 115 must not pull the estimate toward 0.5.
    step = WorkoutStep(
        step_kind=StepKind.WORK,
        duration=Duration.of_time_min(60),
        target=Target.pace_range_s_km(THRESHOLD_PACE, THRESHOLD_PACE),
        hr_cap_bpm=115,
    )
    wo = _workout(WorkoutBlock(steps=(step,)))
    assert _estimate(wo) == pytest.approx(100.0, abs=0.5)


# ─────────────────────────────────────────────────────────────────────────────
# Variable-pace run
# ─────────────────────────────────────────────────────────────────────────────


def test_variable_run_sums_per_step():
    # 20 min @ IF 1.0 + 20 min @ IF 0.78 within one linear block.
    easy_pace = 1000.0 / (THRESHOLD_SPEED * 0.78)
    wo = _workout(
        WorkoutBlock(steps=(
            _work_step(Duration.of_time_min(20), Target.pace_range_s_km(THRESHOLD_PACE, THRESHOLD_PACE)),
            _work_step(Duration.of_time_min(20), Target.pace_range_s_km(easy_pace, easy_pace)),
        ))
    )
    expected = (20 / 60) * 1.0 ** 2 * 100 + (20 / 60) * 0.78 ** 2 * 100
    assert _estimate(wo) == pytest.approx(expected, abs=1.0)


# ─────────────────────────────────────────────────────────────────────────────
# Interval run — recovery steps are skipped
# ─────────────────────────────────────────────────────────────────────────────


def test_interval_recovery_is_skipped():
    # 6 × (800m work @ IF 1.1 + 90s easy recovery). Recovery must NOT add dose.
    work_pace = 1000.0 / (THRESHOLD_SPEED * 1.1)
    work = _work_step(Duration.of_distance_m(800), Target.pace_range_s_km(work_pace, work_pace))
    recovery = WorkoutStep(
        step_kind=StepKind.RECOVERY,
        duration=Duration.of_time_s(90),
        target=Target.pace_range_s_km(400, 400),  # would add dose if not skipped
    )
    with_recovery = _workout(WorkoutBlock(steps=(work, recovery), repeat=6))
    work_only = _workout(WorkoutBlock(steps=(work,), repeat=6))
    assert _estimate(with_recovery) == pytest.approx(_estimate(work_only), abs=1e-6)


def test_interval_work_dose_value():
    # 6 × 800m @ IF 1.1: per rep time = 800 / 4.4 = 181.8s = 3.03 min.
    work_pace = 1000.0 / (THRESHOLD_SPEED * 1.1)
    wo = _workout(
        WorkoutBlock(steps=(
            _work_step(Duration.of_distance_m(800), Target.pace_range_s_km(work_pace, work_pace)),
        ), repeat=6)
    )
    speed = THRESHOLD_SPEED * 1.1
    rep_min = (800.0 / speed) / 60.0
    expected = 6 * (rep_min / 60) * 1.1 ** 2 * 100
    assert _estimate(wo) == pytest.approx(expected, abs=0.5)


# ─────────────────────────────────────────────────────────────────────────────
# Open / default-IF / missing-calibration edge cases
# ─────────────────────────────────────────────────────────────────────────────


def test_open_target_uses_step_kind_default_if():
    # Warmup with no target, time-based → default easy IF ≈ 0.78.
    wo = _workout(
        WorkoutBlock(steps=(
            WorkoutStep(step_kind=StepKind.WARMUP, duration=Duration.of_time_min(10), target=Target.open()),
        ))
    )
    expected = (10 / 60) * 0.78 ** 2 * 100
    assert _estimate(wo) == pytest.approx(expected, abs=1.0)


def test_open_duration_step_is_skipped():
    # The only step is open-duration → nothing computable → None.
    wo = _workout(
        WorkoutBlock(steps=(
            WorkoutStep(step_kind=StepKind.COOLDOWN, duration=Duration.open(), target=Target.open()),
        ))
    )
    assert _estimate(wo) is None


def test_missing_calibration_returns_none():
    # Pace target but no threshold_speed and no HR calibration → None.
    wo = _workout(
        WorkoutBlock(steps=(
            _work_step(Duration.of_time_min(60), Target.pace_range_s_km(THRESHOLD_PACE, THRESHOLD_PACE)),
        ))
    )
    assert estimate_planned_run_load(
        wo, threshold_speed_mps=None, threshold_hr=None, rhr=None
    ) is None


def test_intervals_more_conservative_than_steady_same_time():
    # Documented property: skipping recovery makes an interval session's dose
    # lower than a steady threshold run of the same *total clock time*.
    work_pace = 1000.0 / (THRESHOLD_SPEED * 1.1)
    interval = _workout(
        WorkoutBlock(steps=(
            _work_step(Duration.of_time_min(3), Target.pace_range_s_km(work_pace, work_pace)),
            WorkoutStep(step_kind=StepKind.RECOVERY, duration=Duration.of_time_min(2),
                        target=Target.pace_range_s_km(400, 400)),
        ), repeat=6)
    )  # 30 min clock time
    steady = _workout(
        WorkoutBlock(steps=(
            _work_step(Duration.of_time_min(30), Target.pace_range_s_km(THRESHOLD_PACE, THRESHOLD_PACE)),
        ))
    )
    assert _estimate(interval) < _estimate(steady)


# ─────────────────────────────────────────────────────────────────────────────
# Scale alignment with the actual external-TSS formula (single source of scale)
# ─────────────────────────────────────────────────────────────────────────────


def test_steady_matches_external_tss():
    # A constant-speed planned run must match _compute_external_tss of a
    # constant-speed activity at the same speed/duration. IF = 4.4/4.0 = 1.1.
    speed = 4.4
    duration_s = 3600
    samples = tuple(
        ActivitySample(elapsed_s=float(i), distance_m=speed * i, speed_mps=speed)
        for i in range(0, duration_s + 1)
    )
    activity = ActivityLoadInput(
        label_id="x", activity_date=date(2026, 5, 1), sport="run_outdoor",
        duration_s=duration_s, distance_m=speed * duration_s, samples=samples,
    )
    calib = CalibrationSnapshot(as_of_date=date(2026, 5, 1), threshold_speed_mps=THRESHOLD_SPEED)
    external_tss, _, _, _ = _compute_external_tss(activity, calib)

    pace = 1000.0 / speed
    wo = _workout(
        WorkoutBlock(steps=(
            _work_step(Duration.of_time_s(duration_s), Target.pace_range_s_km(pace, pace)),
        ))
    )
    planned = _estimate(wo)
    assert planned == pytest.approx(external_tss, rel=0.02)
