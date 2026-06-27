"""Phase A1 — training-environment detector (pure)."""

from __future__ import annotations

from datetime import date

import pytest

from coach.environment import training_environment as te
from coach.environment import (
    build_training_environment,
    classify_band,
    detect_change_point,
    per_run_altitude,
)

AS_OF = date(2026, 6, 27)


@pytest.mark.parametrize(
    "alt,band",
    [
        (None, "sea_level"),
        (2, "sea_level"),
        (999, "sea_level"),
        (1000, "low"),
        (1499, "low"),
        (1500, "moderate"),
        (1931, "moderate"),
        (2200, "moderate"),
        (2500, "high"),
        (3500, "very_high"),
    ],
)
def test_classify_band(alt, band):
    assert classify_band(alt) == band


def test_per_run_altitude_ignores_nulls():
    assert per_run_altitude([1929, None, 1933, 1931]) == pytest.approx(1931.0)
    assert per_run_altitude([None, None]) is None


# --- change-point: the three worked cases ----------------------------------


def test_shanghai_to_kunming_is_significant_gain():
    cp = detect_change_point([("2026-06-24", 2.0), ("2026-06-27", 1931.0)], as_of=AS_OF)
    assert cp is not None
    assert cp.from_altitude_m == 2.0
    assert cp.to_altitude_m == 1931.0
    assert cp.days_since == 0


def test_kunming_to_lijiang_small_delta_still_triggers():
    # Δ=400 but both ≥1500 → re-acclimatization needed.
    cp = detect_change_point([("2026-06-24", 1800.0), ("2026-06-27", 2200.0)], as_of=AS_OF)
    assert cp is not None
    assert cp.gain_m == 400.0


def test_shanghai_to_xian_low_destination_no_trigger():
    # Δ=500 but destination 500m < floor → not significant.
    cp = detect_change_point([("2026-06-24", 2.0), ("2026-06-27", 500.0)], as_of=AS_OF)
    assert cp is None


def test_long_term_at_altitude_is_adapted_no_change_point():
    series = [(f"2026-06-{d:02d}", 1900.0) for d in range(1, 28, 3)]
    assert detect_change_point(series, as_of=AS_OF) is None


def test_old_gain_beyond_lookback_is_adapted():
    # Arrived at altitude in March; by late June it's no longer an acute episode.
    series = [("2026-03-01", 2.0)] + [(f"2026-{m:02d}-10", 1900.0) for m in (3, 4, 5, 6)]
    assert detect_change_point(series, as_of=AS_OF) is None


# --- acclimatization: signal-informed --------------------------------------

_ALT = [("2026-06-24", 2.0), ("2026-06-27", 1931.0)]  # change-point on 06-27


def _env(**kw):
    return build_training_environment(altitude_series=_ALT, as_of=AS_OF, **kw)


def test_acclimatization_disturbed_from_elevated_rhr():
    env = _env(rhr_series=[("2026-06-27", 55.0)], rhr_baseline=48.0)
    acc = env.acclimatization
    assert acc is not None
    assert acc.rhr_delta_bpm == 7.0  # 55 - 48
    assert acc.status == "disturbed"
    assert acc.active is True
    assert acc.signal_based is True


def test_acclimatization_stabilized_when_signals_back_to_baseline():
    env = _env(
        rhr_series=[("2026-06-27", 49.0)],
        rhr_baseline=48.0,
        hrv_series=[("2026-06-10", 40.0), ("2026-06-15", 40.0), ("2026-06-27", 39.0)],
    )
    acc = env.acclimatization
    assert acc.status == "stabilized"
    assert acc.active is False


def test_acclimatization_stabilized_when_better_than_baseline():
    """A fitter/adapted athlete (RHR below, HRV above baseline) is stabilized.

    Regression: a symmetric ``abs()`` band pinned such an athlete to
    ``recovering`` forever — only an *elevated* RHR / *suppressed* HRV should
    block ``stabilized``, mirroring the one-sided ``disturbed`` rule.
    """
    env = _env(
        rhr_series=[("2026-06-27", 43.0)],  # 5 bpm BELOW baseline
        rhr_baseline=48.0,
        hrv_series=[("2026-06-10", 40.0), ("2026-06-15", 40.0), ("2026-06-27", 50.0)],  # +25%
    )
    acc = env.acclimatization
    assert acc.rhr_delta_bpm == -5.0
    assert acc.hrv_delta_pct == pytest.approx(25.0)
    assert acc.status == "stabilized"
    assert acc.active is False


def test_acclimatization_disturbed_from_suppressed_hrv():
    env = _env(
        hrv_series=[("2026-06-10", 40.0), ("2026-06-15", 40.0), ("2026-06-27", 27.0)],
    )
    # (27-40)/40 = -32.5% ≤ -10% → disturbed
    assert env.acclimatization.status == "disturbed"
    assert env.acclimatization.hrv_delta_pct == pytest.approx(-32.5)


def test_acclimatization_calendar_fallback_when_no_signals():
    env = _env()  # no rhr/hrv series
    acc = env.acclimatization
    assert acc.signal_based is False
    assert acc.status == "disturbed"  # days_since 0 ≤ acute


# --- full struct -----------------------------------------------------------


def test_build_training_environment_shape():
    env = _env(rhr_series=[("2026-06-27", 55.0)], rhr_baseline=48.0)
    assert env.current_altitude_m == 1931.0
    assert env.altitude_band == "moderate"
    assert env.at_altitude is True
    assert env.weather is None


def test_below_floor_no_acclimatization():
    env = build_training_environment(
        altitude_series=[("2026-06-24", 2.0), ("2026-06-27", 500.0)], as_of=AS_OF
    )
    assert env.at_altitude is False
    assert env.altitude_band == "sea_level"
    assert env.acclimatization is None


def test_module_exports_thresholds():
    # Sanity: doctrine constants present for downstream reference.
    assert te.ALTITUDE_FLOOR_M == 1500.0
    assert te.SIGNIFICANT_GAIN_M == 300.0
