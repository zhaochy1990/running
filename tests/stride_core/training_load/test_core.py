from __future__ import annotations

from datetime import date, timedelta

import pytest

from stride_core.training_load.core import (
    compute_activity_load,
    compute_daily_load_series,
)
from stride_core.training_load.types import (
    ActivityLoadInput,
    ActivityLoadResult,
    ActivitySample,
    CalibrationSnapshot,
    FeedbackRow,
    HealthRow,
    HrvRow,
    SessionClass,
)


def _calibration(**overrides) -> CalibrationSnapshot:
    values = dict(
        as_of_date=date(2026, 5, 1),
        rhr_baseline=50.0,
        hrmax_estimate=190.0,
        threshold_hr=170.0,
        threshold_speed_mps=4.0,
        critical_power_w=300.0,
        source={"test": True},
    )
    values.update(overrides)
    return CalibrationSnapshot(**values)


def _samples(
    duration_s: int = 3600,
    *,
    heart_rate_bpm: float | None = None,
    speed_mps: float | None = None,
    power_w: float | None = None,
    altitude_m: float | None = None,
    step_s: int = 1,
) -> tuple[ActivitySample, ...]:
    return tuple(
        ActivitySample(
            elapsed_s=float(i),
            distance_m=(speed_mps * i) if speed_mps is not None else None,
            heart_rate_bpm=heart_rate_bpm,
            speed_mps=speed_mps,
            power_w=power_w,
            altitude_m=altitude_m,
        )
        for i in range(0, duration_s + 1, step_s)
    )


EASY = SessionClass.EASY


def _activity(
    label_id: str = "a1",
    activity_date: date = date(2026, 5, 1),
    sport: str = "run_outdoor",
    session_class: SessionClass = EASY,
    duration_s: float = 3600,
    distance_m: float | None = 14400,
    samples: tuple[ActivitySample, ...] = (),
    rpe: int | None = None,
) -> ActivityLoadInput:
    return ActivityLoadInput(
        label_id=label_id,
        activity_date=activity_date,
        sport=sport,
        session_class=session_class,
        duration_s=float(duration_s),
        distance_m=distance_m,
        samples=samples,
        rpe=rpe,
    )


def test_one_hour_at_threshold_hr_is_cardio_tss_100():
    result = compute_activity_load(
        _activity(samples=_samples(heart_rate_bpm=170, speed_mps=None)),
        _calibration(threshold_speed_mps=None, critical_power_w=None),
    )

    assert result.cardio_load_raw is not None
    assert result.cardio_load_raw > 0
    assert result.cardio_tss == pytest.approx(100.0, rel=0.01)
    assert result.training_dose == pytest.approx(100.0, rel=0.01)
    assert result.excluded_from_pmc is False


def test_higher_heart_rate_produces_higher_raw_trimp():
    low = compute_activity_load(
        _activity(
            label_id="low",
            samples=_samples(heart_rate_bpm=140, speed_mps=None),
        ),
        _calibration(threshold_speed_mps=None, critical_power_w=None),
    )
    high = compute_activity_load(
        _activity(
            label_id="high",
            samples=_samples(heart_rate_bpm=160, speed_mps=None),
        ),
        _calibration(threshold_speed_mps=None, critical_power_w=None),
    )

    assert high.cardio_load_raw > low.cardio_load_raw


def test_threshold_speed_for_one_hour_is_external_tss_100_and_not_inverse_pace():
    threshold = compute_activity_load(
        _activity(
            label_id="threshold",
            samples=_samples(speed_mps=4.0, heart_rate_bpm=None),
        ),
        _calibration(threshold_hr=None, critical_power_w=None),
    )
    easy = compute_activity_load(
        _activity(
            label_id="easy",
            samples=_samples(speed_mps=2.0, heart_rate_bpm=None),
        ),
        _calibration(threshold_hr=None, critical_power_w=None),
    )

    assert threshold.external_tss == pytest.approx(100.0, rel=0.01)
    # At half threshold speed IF is clamped to 0.5 → external_tss ≈ 25.
    assert easy.external_tss == pytest.approx(25.0, rel=0.01)
    assert easy.external_tss < threshold.external_tss


def _interval_samples(*, recovery_hr: float, repeats: int = 4) -> tuple[ActivitySample, ...]:
    samples: list[ActivitySample] = []
    elapsed = 0
    distance = 0.0
    for _ in range(repeats):
        for _ in range(90):
            speed = 4.4
            distance += speed
            samples.append(
                ActivitySample(
                    elapsed_s=float(elapsed),
                    distance_m=distance,
                    heart_rate_bpm=175.0,
                    speed_mps=speed,
                )
            )
            elapsed += 1
        for _ in range(90):
            speed = 3.2
            distance += speed
            samples.append(
                ActivitySample(
                    elapsed_s=float(elapsed),
                    distance_m=distance,
                    heart_rate_bpm=recovery_hr,
                    speed_mps=speed,
                )
            )
            elapsed += 1
    last = samples[-1]
    samples.append(
        ActivitySample(
            elapsed_s=float(elapsed),
            distance_m=last.distance_m,
            heart_rate_bpm=last.heart_rate_bpm,
            speed_mps=last.speed_mps,
        )
    )
    return tuple(samples)


def test_steady_threshold_run_has_no_high_intensity_supplement():
    result = compute_activity_load(
        _activity(samples=_samples(heart_rate_bpm=170.0, speed_mps=4.0)),
        _calibration(),
    )

    assert result.high_intensity_tss == 0.0
    assert result.training_dose == pytest.approx(100.0, rel=0.01)
    assert result.training_dose_source == "conservative_fusion"


def test_incomplete_recovery_after_intervals_adds_high_intensity_supplement():
    samples = _interval_samples(recovery_hr=165.0)
    result = compute_activity_load(
        _activity(
            duration_s=float(samples[-1].elapsed_s),
            samples=samples,
        ),
        _calibration(),
    )

    assert result.high_intensity_coverage == pytest.approx(1.0, rel=0.01)
    assert result.high_intensity_tss is not None
    assert result.high_intensity_tss > 0
    assert result.training_dose == pytest.approx(
        min(result.cardio_tss, result.external_tss) + result.high_intensity_tss
    )
    assert result.training_dose_source == "conservative_fusion+high_intensity"


def test_recovered_hr_after_same_intervals_has_no_high_intensity_supplement():
    samples = _interval_samples(recovery_hr=145.0)
    result = compute_activity_load(
        _activity(
            duration_s=float(samples[-1].elapsed_s),
            samples=samples,
        ),
        _calibration(),
    )

    assert result.high_intensity_tss == 0.0
    assert result.training_dose == pytest.approx(min(result.cardio_tss, result.external_tss))


def test_partial_interval_trace_does_not_add_high_intensity_supplement():
    samples = _interval_samples(recovery_hr=165.0, repeats=1)
    result = compute_activity_load(
        _activity(duration_s=1800.0, samples=samples),
        _calibration(),
    )

    assert result.high_intensity_coverage == pytest.approx(0.1, rel=0.02)
    assert result.high_intensity_tss is None
    assert result.training_dose is None
    assert "high_intensity_low_coverage" in result.reasons


def _single_work_then_recovery_samples(
    *,
    float_seconds: int,
) -> tuple[ActivitySample, ...]:
    samples: list[ActivitySample] = []
    elapsed = 0
    distance = 0.0
    phases = (
        (90, 4.4, 175.0),
        (float_seconds, 3.8, 170.0),
        (120, 3.2, 165.0),
    )
    for seconds, speed, hr in phases:
        for _ in range(seconds):
            distance += speed
            samples.append(
                ActivitySample(
                    elapsed_s=float(elapsed),
                    distance_m=distance,
                    heart_rate_bpm=hr,
                    speed_mps=speed,
                )
            )
            elapsed += 1
    last = samples[-1]
    samples.append(
        ActivitySample(
            elapsed_s=float(elapsed),
            distance_m=last.distance_m,
            heart_rate_bpm=last.heart_rate_bpm,
            speed_mps=last.speed_mps,
        )
    )
    return tuple(samples)


def test_float_transition_preserves_recovery_eligibility():
    samples = _single_work_then_recovery_samples(float_seconds=60)
    result = compute_activity_load(
        _activity(duration_s=float(samples[-1].elapsed_s), samples=samples),
        _calibration(),
    )

    assert result.high_intensity_tss is not None
    assert result.high_intensity_tss > 0


def test_delayed_recovery_is_not_attributed_to_old_work_bout():
    samples = _single_work_then_recovery_samples(float_seconds=300)
    result = compute_activity_load(
        _activity(duration_s=float(samples[-1].elapsed_s), samples=samples),
        _calibration(),
    )

    assert result.high_intensity_tss == 0.0


def test_unvalidated_power_proxy_does_not_override_speed_load():
    result = compute_activity_load(
        _activity(samples=_samples(power_w=300.0, heart_rate_bpm=None, speed_mps=3.0)),
        _calibration(threshold_hr=None, threshold_speed_mps=4.0, critical_power_w=300.0),
    )

    assert result.external_tss == pytest.approx(56.25, rel=0.01)
    assert result.training_dose == pytest.approx(56.25, rel=0.01)


def test_power_and_gps_spikes_are_clamped_before_normalized_if():
    samples = list(_samples(speed_mps=4.0, heart_rate_bpm=None))
    samples[900] = ActivitySample(elapsed_s=900.0, speed_mps=80.0)

    result = compute_activity_load(
        _activity(samples=tuple(samples)),
        _calibration(threshold_hr=None, critical_power_w=None),
    )

    assert result.external_tss == pytest.approx(100.0, rel=0.05)
    assert result.external_tss < 110.0


def test_session_label_does_not_change_measured_load():
    samples = _samples(heart_rate_bpm=150, speed_mps=4.4)
    easy = compute_activity_load(
        _activity(label_id="easy", session_class=SessionClass.EASY, samples=samples),
        _calibration(),
    )
    interval = compute_activity_load(
        _activity(label_id="interval", session_class=SessionClass.INTERVAL, samples=samples),
        _calibration(),
    )

    assert interval.external_tss > interval.cardio_tss
    assert interval.training_dose == pytest.approx(easy.training_dose)
    assert interval.training_dose_source == "conservative_fusion"


def test_hr_coverage_counts_only_intervals_with_valid_hr():
    samples = list(_samples(duration_s=3600, heart_rate_bpm=None, speed_mps=None))
    for i in range(601):
        samples[i] = ActivitySample(elapsed_s=float(i), heart_rate_bpm=170.0)

    result = compute_activity_load(
        _activity(samples=tuple(samples)),
        _calibration(threshold_speed_mps=None, critical_power_w=None),
    )

    assert result.cardio_tss == pytest.approx(100.0 / 6.0, rel=0.01)
    assert result.cardio_coverage == pytest.approx(1.0 / 6.0, rel=0.01)
    assert result.training_dose is None
    assert "heart_rate_low_coverage" in result.reasons


def test_external_load_is_timestamp_weighted_not_sample_weighted():
    def make(dense_first_half: bool) -> tuple[ActivitySample, ...]:
        first_step, second_step = (1, 10) if dense_first_half else (10, 1)
        times = list(range(0, 1800, first_step)) + list(range(1800, 3601, second_step))
        return tuple(
            ActivitySample(
                elapsed_s=float(t),
                speed_mps=2.0 if t < 1800 else 4.0,
            )
            for t in sorted(set(times))
        )

    first_dense = compute_activity_load(
        _activity(samples=make(True)),
        _calibration(threshold_hr=None, critical_power_w=None),
    )
    second_dense = compute_activity_load(
        _activity(samples=make(False)),
        _calibration(threshold_hr=None, critical_power_w=None),
    )

    assert first_dense.external_tss == pytest.approx(second_dense.external_tss, rel=0.01)
    expected_if = ((0.5**6 + 1.0**6) / 2.0) ** (1.0 / 6.0)
    assert first_dense.external_tss == pytest.approx(100.0 * expected_if**2, rel=0.02)


def test_partial_external_trace_is_not_extrapolated_to_summary_duration():
    result = compute_activity_load(
        _activity(duration_s=3600, samples=_samples(duration_s=600, speed_mps=4.0)),
        _calibration(threshold_hr=None, critical_power_w=None),
    )

    assert result.external_tss == pytest.approx(100.0 / 6.0, rel=0.01)
    assert result.external_coverage == pytest.approx(1.0 / 6.0, rel=0.01)
    assert result.training_dose is None


def test_non_running_activity_never_uses_running_speed_threshold():
    result = compute_activity_load(
        _activity(sport="cycling", samples=_samples(speed_mps=8.0, heart_rate_bpm=None)),
        _calibration(threshold_hr=None, critical_power_w=None),
    )

    assert result.external_tss is None
    assert result.training_dose is None
    assert "external_not_supported_for_sport" in result.reasons


def test_missing_hr_still_uses_reliable_speed_or_power_load():
    result = compute_activity_load(
        _activity(samples=_samples(heart_rate_bpm=None, speed_mps=4.0)),
        _calibration(threshold_hr=None, critical_power_w=None),
    )

    assert result.cardio_load_raw is None
    assert result.external_tss == pytest.approx(100.0, rel=0.01)
    assert result.training_dose == pytest.approx(result.external_tss)
    assert result.excluded_from_pmc is False


def test_missing_threshold_hr_keeps_raw_trimp_out_of_pmc():
    result = compute_activity_load(
        _activity(samples=_samples(heart_rate_bpm=160, speed_mps=None)),
        _calibration(threshold_hr=None, threshold_speed_mps=None, critical_power_w=None),
    )

    assert result.cardio_load_raw is not None
    assert result.cardio_tss is None
    assert result.training_dose is None
    assert result.excluded_from_pmc is True
    assert "threshold_hr_missing" in result.reasons


def test_flat_easy_run_mechanical_load_is_close_to_distance_km():
    """Design-doc acceptance bar: flat easy run gives mechanical_load/distance_km ≈ 1.0.

    No ascent/descent, easy-pace IF ≈ 0.5 → intensity_factor = 1 + 0.5 * max(0, 0.5-0.85)^2
    = 1.0613, so 14.4 km * 1.0 * 1.0 * 1.0613 ≈ 15.28. We allow ≤ 1.10 / km to keep the
    proxy honest on benign terrain.
    """
    result = compute_activity_load(
        _activity(
            distance_m=14400,
            samples=_samples(speed_mps=2.0, altitude_m=0.0, heart_rate_bpm=None),
        ),
        _calibration(threshold_hr=None, critical_power_w=None),
    )

    assert result.mechanical_load is not None
    distance_km = 14.4
    ratio = result.mechanical_load / distance_km
    assert ratio == pytest.approx(1.0, abs=0.10)


def test_strength_without_hr_or_tss_like_external_load_is_excluded_from_pmc():
    result = compute_activity_load(
        _activity(
            sport="strength",
            session_class=SessionClass.STRENGTH,
            duration_s=2400,
            distance_m=None,
            samples=(),
            rpe=8,
        ),
        _calibration(),
    )

    assert result.subjective_internal_load == pytest.approx(8 * 40)
    assert result.training_dose is None
    assert result.excluded_from_pmc is True
    assert "no_tss_like_objective_load" in result.reasons


def _load_result(
    label_id: str,
    day: date,
    dose: float,
    session_class: SessionClass = SessionClass.EASY,
    duration_minutes: float = 60.0,
) -> ActivityLoadResult:
    return ActivityLoadResult(
        label_id=label_id,
        activity_date=day,
        sport="run_outdoor",
        session_class=session_class,
        duration_minutes=duration_minutes,
        training_dose=dose,
        excluded_from_pmc=False,
    )


def test_srpe_feedback_does_not_change_training_dose_atl_ctl_or_tsb():
    start = date(2026, 5, 1)
    activities = [_load_result("a1", start, 100.0)]
    feedback = [FeedbackRow(label_id="a1", activity_date=start, rpe=10, duration_minutes=60.0)]

    without = compute_daily_load_series(activities, [], [], [], start, start)[0]
    with_feedback = compute_daily_load_series(activities, [], [], feedback, start, start)[0]

    assert without.training_dose == with_feedback.training_dose
    assert without.acute_load == with_feedback.acute_load
    assert without.chronic_load == with_feedback.chronic_load
    assert without.form == with_feedback.form


def test_high_srpe_low_objective_load_only_adds_readiness_reason():
    start = date(2026, 5, 1)
    prior_days = []
    for i in range(6):
        day = start + timedelta(days=i)
        prior_days.append(_load_result(f"hist{i}", day, 50.0, duration_minutes=60.0))
    current = start + timedelta(days=6)
    activities = prior_days + [_load_result("today", current, 10.0, duration_minutes=60.0)]
    feedback = [
        FeedbackRow(a.label_id, a.activity_date, 3, a.duration_minutes)
        for a in prior_days
    ]
    feedback.append(FeedbackRow("today", current, 9, 60.0))

    rows = compute_daily_load_series(activities, [], [], feedback, start, current)

    assert rows[-1].training_dose == pytest.approx(10.0)
    assert rows[-1].readiness_gate in {"yellow", "red"}
    assert "srpe_dissociation" in rows[-1].readiness_reasons


def test_hrv_robust_scale_floor_prevents_tiny_mad_false_reds():
    start = date(2026, 5, 1)
    hrv_rows = [HrvRow(start + timedelta(days=i), last_night_avg=60.0) for i in range(14)]
    hrv_rows.append(HrvRow(start + timedelta(days=14), last_night_avg=55.0))

    rows = compute_daily_load_series([], [], hrv_rows, [], start, start + timedelta(days=14))

    assert rows[-1].readiness_gate == "yellow"
    assert "low_hrv" in rows[-1].readiness_reasons
