from __future__ import annotations

from datetime import date, timedelta

import pytest

from stride_core.training_load.core import (
    _distance_window_grade,
    _precompute_grades,
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
    covered_hours = result.high_intensity_coverage * result.duration_minutes / 60.0
    assert result.high_intensity_tss <= 75.0 * covered_hours + 0.1


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


def test_separate_short_surges_do_not_combine_into_qualifying_work_bout():
    samples: list[ActivitySample] = []
    elapsed = 0
    distance = 0.0
    # Neither 40-second surge reaches the 60-second work minimum. The 10-second
    # easy interval must end the first candidate even though the smoothed speed
    # remains elevated briefly. Elevated HR after the second surge makes the
    # old accidental concatenation observable as a false supplement.
    for seconds, speed in ((40, 5.2), (10, 2.0), (40, 5.2), (180, 2.0)):
        for _ in range(seconds):
            distance += speed
            samples.append(
                ActivitySample(
                    elapsed_s=float(elapsed),
                    distance_m=distance,
                    heart_rate_bpm=180.0,
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

    result = compute_activity_load(
        _activity(
            duration_s=float(elapsed),
            distance_m=distance,
            samples=tuple(samples),
        ),
        _calibration(),
    )

    assert result.high_intensity_tss == 0.0


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


def test_missing_samples_expire_recovery_eligibility():
    samples: list[ActivitySample] = []
    elapsed = 0
    distance = 0.0
    phases = (
        (90, 4.4, 175.0),
        (241, None, None),
        (120, 3.2, 165.0),
        # Keep overall dual-channel coverage above 80% so the assertion tests
        # recovery-state expiry rather than the low-coverage gate.
        (1000, 3.0, 150.0),
    )
    for seconds, speed, hr in phases:
        for _ in range(seconds):
            if speed is not None:
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
    samples.append(
        ActivitySample(
            elapsed_s=float(elapsed),
            distance_m=distance,
            heart_rate_bpm=150.0,
            speed_mps=3.0,
        )
    )

    result = compute_activity_load(
        _activity(duration_s=float(elapsed), samples=tuple(samples)),
        _calibration(),
    )

    assert result.high_intensity_coverage >= 0.8
    assert result.high_intensity_tss == 0.0


def test_pause_sized_timestamp_gap_clears_recovery_eligibility():
    samples = list(_single_work_then_recovery_samples(float_seconds=0))
    shifted: list[ActivitySample] = []
    for index, sample in enumerate(samples):
        elapsed = float(sample.elapsed_s or 0.0)
        if index >= 90:
            elapsed += 301.0
        shifted.append(
            ActivitySample(
                elapsed_s=elapsed,
                distance_m=sample.distance_m,
                heart_rate_bpm=sample.heart_rate_bpm,
                speed_mps=sample.speed_mps,
            )
        )
    # Add enough fully observed easy running that the pause gap does not trip
    # the overall 80% coverage gate.
    last = shifted[-1]
    distance = float(last.distance_m or 0.0)
    elapsed = float(last.elapsed_s or 0.0)
    for _ in range(1400):
        elapsed += 1.0
        distance += 3.0
        shifted.append(
            ActivitySample(
                elapsed_s=elapsed,
                distance_m=distance,
                heart_rate_bpm=150.0,
                speed_mps=3.0,
            )
        )

    result = compute_activity_load(
        _activity(duration_s=elapsed, samples=tuple(shifted)),
        _calibration(),
    )

    assert result.high_intensity_coverage >= 0.8
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


# ---------------------------------------------------------------------------
# _distance_window_grade and _precompute_grades
# ---------------------------------------------------------------------------


def _make_samples(
    distances: list[float | None],
    altitudes: list[float | None],
) -> tuple[ActivitySample, ...]:
    """Build samples with the given distance_m and altitude_m lists."""
    assert len(distances) == len(altitudes)
    return tuple(
        ActivitySample(elapsed_s=float(i), distance_m=d, altitude_m=a)
        for i, (d, a) in enumerate(zip(distances, altitudes))
    )


def test_grade_flat_returns_zero():
    # All at same altitude → grade 0.0
    samples = _make_samples(
        distances=[0.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0],
        altitudes=[100.0] * 7,
    )
    g = _distance_window_grade(samples, 3)
    assert g == pytest.approx(0.0)


def test_grade_uphill_clamped():
    # Rise of 100 m over 50 m span → raw grade 2.0 → clamped to 0.2
    samples = _make_samples(
        distances=[0.0, 50.0],
        altitudes=[0.0, 100.0],
    )
    g = _distance_window_grade(samples, 1)
    assert g == pytest.approx(0.2)


def test_grade_downhill_clamped():
    # Drop of 100 m over 50 m span → raw grade -2.0 → clamped to -0.2
    samples = _make_samples(
        distances=[0.0, 50.0],
        altitudes=[100.0, 0.0],
    )
    g = _distance_window_grade(samples, 0)
    assert g == pytest.approx(-0.2)


def test_grade_below_20m_minimum_returns_none():
    # Window spans only 15 m → below 20 m minimum → None
    samples = _make_samples(
        distances=[0.0, 5.0, 10.0, 15.0],
        altitudes=[100.0, 101.0, 102.0, 103.0],
    )
    g = _distance_window_grade(samples, 2)
    assert g is None


def test_grade_missing_altitude_at_index_returns_none():
    samples = _make_samples(
        distances=[0.0, 25.0, 50.0, 75.0, 100.0],
        altitudes=[100.0, None, 105.0, 107.0, 110.0],
    )
    g = _distance_window_grade(samples, 1)
    assert g is None


def test_grade_none_distance_stops_scan():
    # Sample at index 2 has None distance → backward scan stops before it
    samples = _make_samples(
        distances=[None, 0.0, None, 50.0, 100.0],
        altitudes=[90.0, 100.0, None, 110.0, 120.0],
    )
    # Index 3: backward scan tries lo-1=2 which has distance_m=None → stops at lo=3
    # hi tries 4: 100-50=50 ≤ 50 → hi=4; dist=100-50=50 ≥ 20; grade=(120-110)/50=0.2
    g = _distance_window_grade(samples, 3)
    assert g == pytest.approx(0.2)


def test_grade_50m_exact_boundary_included():
    # Samples at 0, 50, 100: window from index 1 → back to 0 (50m exactly ≤50 ok),
    # forward to 2 would be 50 > 50 → stop at hi=1; dist = 50-0 = 50 ≥ 20
    samples = _make_samples(
        distances=[0.0, 50.0, 100.0],
        altitudes=[100.0, 110.0, 120.0],
    )
    # backward: lo-1=0, 50-0=50 which is NOT > 50, so lo=0
    # forward: hi+1=2, 100-50=50 which IS > 50, so stop at hi=1
    # dist = samples[1].distance_m - samples[0].distance_m = 50-0 = 50
    # grade = (110-100)/50 = 0.2
    g = _distance_window_grade(samples, 1)
    assert g == pytest.approx(0.2)


def test_grade_51m_boundary_excluded():
    # Distance from cur to neighbor is 51 → excluded from window
    samples = _make_samples(
        distances=[0.0, 51.0],
        altitudes=[100.0, 115.0],
    )
    # index 1: backward: cur.distance_m - samples[0].distance_m = 51 > 50 → stop at lo=1
    # hi stays at 1; dist = 51-51=0 < 20 → None
    g = _distance_window_grade(samples, 1)
    assert g is None


def test_precompute_grades_matches_per_index():
    """_precompute_grades must return identical values as _distance_window_grade for every index."""
    import random

    rng = random.Random(42)
    n = 200
    # Build a realistic ascending distance series with occasional None gaps
    distances: list[float | None] = []
    d = 0.0
    for _ in range(n):
        if rng.random() < 0.05:
            distances.append(None)
        else:
            d += rng.uniform(1.0, 5.0)
            distances.append(d)

    altitudes: list[float | None] = []
    a = 50.0
    for _ in range(n):
        if rng.random() < 0.05:
            altitudes.append(None)
        else:
            a += rng.uniform(-2.0, 2.0)
            altitudes.append(a)

    samples = _make_samples(distances, altitudes)

    expected = [_distance_window_grade(samples, i) for i in range(n)]
    got = _precompute_grades(samples)

    assert len(got) == n
    for i, (e, g) in enumerate(zip(expected, got)):
        if e is None:
            assert g is None, f"index {i}: expected None, got {g}"
        else:
            assert g == pytest.approx(e, abs=1e-9), f"index {i}: expected {e}, got {g}"


def test_precompute_grades_all_none_distances():
    samples = _make_samples(
        distances=[None, None, None],
        altitudes=[100.0, 101.0, 102.0],
    )
    result = _precompute_grades(samples)
    assert result == [None, None, None]


def test_precompute_grades_empty():
    result = _precompute_grades(())
    assert result == []


def test_precompute_grades_single_sample():
    samples = _make_samples(distances=[0.0], altitudes=[100.0])
    # Only one sample → dist=0 < 20 → None
    result = _precompute_grades(samples)
    assert result == [None]


def test_precompute_grades_preserves_reference_after_backward_distance_jump():
    samples = _make_samples(
        distances=[0.0, 10.0, 20.0, 1000.0, 30.0, 40.0, 50.0],
        altitudes=[100.0, 101.0, 102.0, 103.0, 104.0, 105.0, 106.0],
    )

    assert _precompute_grades(samples) == [
        _distance_window_grade(samples, index) for index in range(len(samples))
    ]
