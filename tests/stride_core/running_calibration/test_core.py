from __future__ import annotations

from datetime import date, timedelta

import pytest

from stride_core.running_calibration import compute_training_zones, estimate_running_calibration
from stride_core.running_calibration.segments import best_speed_candidates
from stride_core.running_calibration.types import (
    RUNNING_CALIBRATION_MODEL_VERSION,
    CalibrationConfidence,
    RunningActivity,
    RunningLap,
    RunningSample,
)


def _steady_activity(
    label_id: str,
    as_of: date,
    *,
    days_ago: int,
    duration_s: int,
    speed_mps: float,
    hr_bpm: float,
    max_hr: float | None = None,
) -> RunningActivity:
    return RunningActivity(
        label_id=label_id,
        activity_date=as_of - timedelta(days=days_ago),
        sport="run_outdoor",
        duration_s=duration_s,
        distance_m=speed_mps * duration_s,
        avg_hr=hr_bpm,
        max_hr=max_hr or hr_bpm + 8,
        samples=tuple(
            RunningSample(
                elapsed_s=float(t),
                distance_m=speed_mps * t,
                heart_rate_bpm=hr_bpm if t >= 600 else hr_bpm - 12 + 12 * (t / 600),
                speed_mps=speed_mps,
            )
            for t in range(0, duration_s + 1, 30)
        ),
    )


def test_stable_30_minute_threshold_effort_estimates_threshold_hr():
    as_of = date(2026, 5, 1)
    history = [
        _steady_activity(
            "threshold_30m",
            as_of,
            days_ago=3,
            duration_s=30 * 60,
            speed_mps=4.2,
            hr_bpm=168,
            max_hr=184,
        )
    ]

    snapshot = estimate_running_calibration(history, as_of)

    assert snapshot.threshold_speed_mps == pytest.approx(4.03, rel=0.03)
    assert snapshot.threshold_speed_confidence == CalibrationConfidence.MEDIUM
    assert snapshot.threshold_hr == pytest.approx(168, abs=2)
    assert snapshot.threshold_hr_confidence == CalibrationConfidence.HIGH
    assert [e.label_id for e in snapshot.evidence if e.kind == "threshold_hr"] == ["threshold_30m"]


def test_60_minute_performance_recovers_threshold_speed():
    as_of = date(2026, 5, 1)
    history = [
        _steady_activity("best_60m", as_of, days_ago=1, duration_s=60 * 60, speed_mps=4.0, hr_bpm=166),
        _steady_activity("short_fast", as_of, days_ago=5, duration_s=5 * 60, speed_mps=4.8, hr_bpm=174),
    ]

    snapshot = estimate_running_calibration(history, as_of)

    assert snapshot.threshold_speed_mps == pytest.approx(4.0, rel=0.02)
    assert snapshot.threshold_speed_confidence == CalibrationConfidence.HIGH


def test_overlapping_lap_streams_do_not_create_longer_best_efforts():
    as_of = date(2026, 5, 1)
    laps: list[RunningLap] = []
    for lap_index in range(6):
        laps.extend(
            [
                RunningLap(lap_index=lap_index, duration_s=430, distance_m=1000, lap_type="autoKm"),
                RunningLap(lap_index=lap_index, duration_s=690, distance_m=1609, lap_type="autoMile"),
                RunningLap(lap_index=lap_index, duration_s=430, distance_m=1000, lap_type="type2"),
            ]
        )
    activity = RunningActivity(
        label_id="overlapping_laps",
        activity_date=as_of,
        sport="run_outdoor",
        duration_s=43 * 60,
        distance_m=6020,
        laps=tuple(laps),
    )

    candidates = best_speed_candidates([activity], [60 * 60])

    assert candidates == []


def test_medium_confidence_60_minute_lap_uses_performance_model_not_direct_copy():
    as_of = date(2026, 5, 1)
    lap_60 = RunningActivity(
        label_id="lap_60m",
        activity_date=as_of - timedelta(days=1),
        sport="run_outdoor",
        duration_s=60 * 60,
        distance_m=4.0 * 60 * 60,
        laps=tuple(
            RunningLap(lap_index=i, duration_s=600, distance_m=4.0 * 600, lap_type="autoKm")
            for i in range(6)
        ),
    )
    steady_45 = _steady_activity(
        "steady_45m",
        as_of,
        days_ago=5,
        duration_s=45 * 60,
        speed_mps=4.25,
        hr_bpm=166,
    )
    steady_30 = _steady_activity(
        "steady_30m",
        as_of,
        days_ago=10,
        duration_s=30 * 60,
        speed_mps=4.4,
        hr_bpm=168,
    )

    snapshot = estimate_running_calibration([lap_60, steady_45, steady_30], as_of)

    assert snapshot.threshold_speed_mps is not None
    assert snapshot.threshold_speed_mps > 4.05
    assert snapshot.threshold_speed_mps < 4.25
    assert snapshot.threshold_speed_confidence == CalibrationConfidence.HIGH
    assert snapshot.algorithm_version == 3
    assert snapshot.source["algorithm"] == "running_calibration_v3"


def test_interval_recovery_windows_do_not_pollute_threshold_hr():
    as_of = date(2026, 5, 1)
    samples: list[RunningSample] = []
    distance = 0.0
    for t in range(0, 60 * 60 + 1, 30):
        phase = (t // 180) % 2
        speed = 5.0 if phase == 0 else 2.2
        if t > 0:
            distance += speed * 30
        samples.append(
            RunningSample(
                elapsed_s=float(t),
                distance_m=distance,
                heart_rate_bpm=176 if phase == 0 else 136,
                speed_mps=speed,
            )
        )
    intervals = RunningActivity(
        label_id="intervals",
        activity_date=as_of - timedelta(days=2),
        sport="run_outdoor",
        duration_s=60 * 60,
        distance_m=distance,
        avg_hr=156,
        max_hr=188,
        samples=tuple(samples),
    )
    threshold = _steady_activity(
        "steady_threshold",
        as_of,
        days_ago=8,
        duration_s=35 * 60,
        speed_mps=4.05,
        hr_bpm=166,
        max_hr=182,
    )

    snapshot = estimate_running_calibration([intervals, threshold], as_of)

    hr_evidence = [e.label_id for e in snapshot.evidence if e.kind == "threshold_hr"]
    assert hr_evidence == ["steady_threshold"]
    assert snapshot.threshold_hr == pytest.approx(166, abs=2)


def test_threshold_hr_rejects_low_hr_outlier_segments():
    as_of = date(2026, 5, 1)
    history = [
        _steady_activity("low_hr_fast", as_of, days_ago=2, duration_s=30 * 60, speed_mps=4.5, hr_bpm=140, max_hr=200),
        _steady_activity("hard_10k", as_of, days_ago=7, duration_s=38 * 60, speed_mps=4.4, hr_bpm=168, max_hr=181),
        _steady_activity("hard_tempo", as_of, days_ago=14, duration_s=40 * 60, speed_mps=4.25, hr_bpm=169, max_hr=180),
    ]

    snapshot = estimate_running_calibration(history, as_of)

    assert snapshot.threshold_hr == pytest.approx(168, abs=2)
    assert "low_hr_fast" not in [e.label_id for e in snapshot.evidence if e.kind == "threshold_hr"]


def test_threshold_hr_rejects_cluster_of_low_hr_device_segments_when_hrmax_is_known():
    as_of = date(2026, 5, 1)
    history = [
        _steady_activity("bad_optical_1", as_of, days_ago=2, duration_s=35 * 60, speed_mps=4.15, hr_bpm=145, max_hr=190),
        _steady_activity("bad_optical_2", as_of, days_ago=4, duration_s=35 * 60, speed_mps=4.12, hr_bpm=147, max_hr=188),
        _steady_activity("bad_optical_3", as_of, days_ago=6, duration_s=35 * 60, speed_mps=4.1, hr_bpm=142, max_hr=189),
        _steady_activity("tempo_1", as_of, days_ago=10, duration_s=40 * 60, speed_mps=4.08, hr_bpm=166, max_hr=184),
        _steady_activity("tempo_2", as_of, days_ago=14, duration_s=40 * 60, speed_mps=4.05, hr_bpm=168, max_hr=185),
    ]

    snapshot = estimate_running_calibration(history, as_of)

    assert snapshot.threshold_hr == pytest.approx(167, abs=2)
    assert not [e for e in snapshot.evidence if e.kind == "threshold_hr" and e.label_id.startswith("bad_optical")]


def test_threshold_hr_is_empty_when_all_candidates_fail_known_hrmax_plausibility():
    as_of = date(2026, 5, 1)
    history = [
        _steady_activity(
            "bad_optical_only",
            as_of,
            days_ago=2,
            duration_s=35 * 60,
            speed_mps=4.1,
            hr_bpm=140,
            max_hr=200,
        )
    ]

    snapshot = estimate_running_calibration(history, as_of)

    assert snapshot.threshold_speed_mps is not None
    assert snapshot.threshold_hr is None
    assert snapshot.threshold_hr_confidence == CalibrationConfidence.NONE
    assert not [e for e in snapshot.evidence if e.kind == "threshold_hr"]


def test_hrmax_profile_separates_observed_max_from_high_reference():
    as_of = date(2026, 5, 1)
    samples = tuple(
            RunningSample(
                elapsed_s=float(i * 30),
                distance_m=4.0 * i * 30,
                heart_rate_bpm=184 if i >= 118 else 150 + min(i, 20),
                speed_mps=4.0,
            )
        for i in range(120)
    )
    activity = RunningActivity(
        label_id="hrmax_run",
        activity_date=as_of - timedelta(days=1),
        sport="run_outdoor",
        duration_s=3600,
        distance_m=14400,
        avg_hr=168,
        max_hr=184,
        samples=samples,
    )

    snapshot = estimate_running_calibration([activity], as_of)

    assert snapshot.observed_max_hr == 184
    assert snapshot.hrmax_estimate == 184
    assert snapshot.hrmax_confidence == CalibrationConfidence.MEDIUM
    assert snapshot.high_hr_reference is not None
    assert snapshot.high_hr_reference <= snapshot.observed_max_hr
    assert snapshot.source["hrmax_profile"]["method"] == "observed_valid_max_with_distribution_reference"


def test_hrmax_profile_ignores_isolated_timeseries_spike():
    as_of = date(2026, 5, 1)
    samples = []
    for i in range(60):
        hr = 158 if i == 30 else 150 + min(i // 10, 5)
        samples.append(
            RunningSample(
                elapsed_s=float(i * 30),
                distance_m=3.0 * i * 30,
                heart_rate_bpm=hr,
                speed_mps=3.0,
            )
        )
    samples.append(
        RunningSample(elapsed_s=1800.0, distance_m=5400.0, heart_rate_bpm=220, speed_mps=3.0)
    )
    activity = RunningActivity(
        label_id="spike_hr",
        activity_date=as_of - timedelta(days=1),
        sport="run_outdoor",
        duration_s=1800,
        distance_m=5400,
        avg_hr=153,
        samples=tuple(samples),
    )

    snapshot = estimate_running_calibration([activity], as_of)

    assert snapshot.observed_max_hr == 158
    assert snapshot.hrmax_estimate == 158
    assert snapshot.source["hrmax_profile"]["raw_observed_max_hr"] == 220


def test_hrmax_profile_does_not_let_activity_max_corroborate_its_own_spike():
    as_of = date(2026, 5, 1)
    samples = tuple(
        RunningSample(
            elapsed_s=float(i * 30),
            distance_m=3.0 * i * 30,
            heart_rate_bpm=220 if i == 30 else 154,
            speed_mps=3.0,
        )
        for i in range(61)
    )
    activity = RunningActivity(
        label_id="summary_spike_hr",
        activity_date=as_of - timedelta(days=1),
        sport="run_outdoor",
        duration_s=1800,
        distance_m=5400,
        avg_hr=154,
        max_hr=220,
        samples=samples,
    )

    snapshot = estimate_running_calibration([activity], as_of)

    assert snapshot.observed_max_hr == 154
    assert snapshot.hrmax_estimate == 154
    assert snapshot.source["hrmax_profile"]["raw_observed_max_hr"] == 220


def test_threshold_hr_rejects_high_hr_race_outlier_segments():
    as_of = date(2026, 5, 1)
    history = [
        _steady_activity("10k_race", as_of, days_ago=2, duration_s=2450, speed_mps=4.1, hr_bpm=176, max_hr=184),
        _steady_activity("tempo_1", as_of, days_ago=7, duration_s=3600, speed_mps=4.0, hr_bpm=166, max_hr=178),
        _steady_activity("tempo_2", as_of, days_ago=14, duration_s=4200, speed_mps=3.9, hr_bpm=164, max_hr=176),
    ]

    snapshot = estimate_running_calibration(history, as_of)

    assert snapshot.threshold_hr == pytest.approx(165, abs=2)
    assert "10k_race" not in [e.label_id for e in snapshot.evidence if e.kind == "threshold_hr"]


def test_gps_distance_spike_does_not_raise_threshold_speed():
    as_of = date(2026, 5, 1)
    samples = []
    for t in range(0, 60 * 60 + 1, 30):
        spike_offset = 800.0 if t >= 600 else 0.0
        samples.append(
            RunningSample(
                elapsed_s=float(t),
                distance_m=4.0 * t + spike_offset,
                heart_rate_bpm=166,
                speed_mps=14.0 if t == 600 else 4.0,
            )
        )
    activity = RunningActivity(
        label_id="spiky_gps",
        activity_date=as_of - timedelta(days=1),
        sport="run_outdoor",
        duration_s=60 * 60,
        distance_m=4.0 * 60 * 60,
        avg_hr=166,
        max_hr=182,
        samples=tuple(samples),
    )

    snapshot = estimate_running_calibration([activity], as_of)

    assert snapshot.threshold_speed_mps == pytest.approx(4.0, abs=0.06)


def test_insufficient_history_returns_empty_low_confidence_snapshot():
    snapshot = estimate_running_calibration([], date(2026, 5, 1))

    assert snapshot.algorithm_version == RUNNING_CALIBRATION_MODEL_VERSION
    assert snapshot.threshold_speed_mps is None
    assert snapshot.threshold_hr is None
    assert snapshot.threshold_speed_confidence == CalibrationConfidence.NONE
    assert snapshot.threshold_hr_confidence == CalibrationConfidence.NONE
    assert compute_training_zones(snapshot).pace_zones == ()


def test_training_zones_are_anchored_to_threshold_speed_and_hr():
    as_of = date(2026, 5, 1)
    snapshot = estimate_running_calibration(
        [_steady_activity("best_60m", as_of, days_ago=1, duration_s=60 * 60, speed_mps=4.0, hr_bpm=168)],
        as_of,
    )

    zones = compute_training_zones(snapshot)

    assert [z.name for z in zones.pace_zones] == [
        "recovery",
        "easy",
        "marathon",
        "threshold",
        "interval",
        "repetition",
    ]
    threshold_pace = next(z for z in zones.pace_zones if z.name == "threshold")
    assert threshold_pace.min_pace_s_per_km == pytest.approx(243, abs=2)
    assert threshold_pace.max_pace_s_per_km == pytest.approx(258, abs=2)
    threshold_hr = next(z for z in zones.heart_rate_zones if z.name == "threshold")
    assert threshold_hr.min_bpm == pytest.approx(158, abs=1)
    assert threshold_hr.max_bpm == pytest.approx(170, abs=1)
