from __future__ import annotations

from datetime import date, timedelta

import pytest

from stride_core.running_calibration.prediction import (
    ModelPrior,
    SpeedDurationModel,
    durability_factor,
    fit_speed_duration_model,
    predict_race,
)
from stride_core.running_calibration.segments import SpeedCandidate
from stride_core.running_calibration.types import CalibrationConfidence, RunningActivity


def _cand(
    as_of: date,
    *,
    duration_s: int,
    speed_mps: float,
    days_ago: int = 5,
    confidence: CalibrationConfidence = CalibrationConfidence.HIGH,
    source: str = "timeseries",
    label: str | None = None,
) -> SpeedCandidate:
    activity = RunningActivity(
        label_id=label or f"effort_{duration_s}",
        activity_date=as_of - timedelta(days=days_ago),
        sport="run_outdoor",
    )
    return SpeedCandidate(
        activity=activity,
        duration_s=float(duration_s),
        avg_speed_mps=float(speed_mps),
        source=source,
        confidence=confidence,
    )


def _envelope(as_of: date, points: list[tuple[int, float]], **kw) -> dict[float, SpeedCandidate]:
    """Build a best_by_duration map; each bucket is a distinct activity."""
    return {float(d): _cand(as_of, duration_s=d, speed_mps=v, **kw) for d, v in points}


# --- Phase 1.1 / 1.2 — curve shape reflects athlete type --------------------


def test_endurance_athlete_fits_flat_curve():
    as_of = date(2026, 6, 27)
    envelope = _envelope(
        as_of,
        [(180, 4.30), (300, 4.25), (600, 4.20), (1200, 4.15), (1800, 4.10), (2700, 4.05), (3600, 4.0)],
    )

    model = fit_speed_duration_model(envelope, as_of)

    assert model.riegel_k is not None
    assert model.riegel_k < 0.04  # flat decay
    assert model.endurance_index is not None and model.endurance_index > 0.7
    assert model.confidence == CalibrationConfidence.HIGH


def test_stale_long_anchor_caps_model_confidence_below_high():
    """A fresh short-effort cluster with a months-old long end must not read as
    HIGH — model confidence should mirror the threshold's durability bar."""
    as_of = date(2026, 6, 27)
    envelope = {
        180.0: _cand(as_of, duration_s=180, speed_mps=4.80, days_ago=10, label="s3"),
        300.0: _cand(as_of, duration_s=300, speed_mps=4.60, days_ago=10, label="s5"),
        600.0: _cand(as_of, duration_s=600, speed_mps=4.40, days_ago=10, label="s10"),
        1200.0: _cand(as_of, duration_s=1200, speed_mps=4.25, days_ago=12, label="s20"),
        2700.0: _cand(as_of, duration_s=2700, speed_mps=4.10, days_ago=150, label="stale45"),
        3600.0: _cand(as_of, duration_s=3600, speed_mps=4.00, days_ago=160, label="stale60"),
    }

    model = fit_speed_duration_model(envelope, as_of)

    assert model.riegel_k is not None  # still fits and is usable (MEDIUM uses k)
    assert model.confidence == CalibrationConfidence.MEDIUM


def test_speed_athlete_fits_steep_curve():
    as_of = date(2026, 6, 27)
    envelope = _envelope(
        as_of,
        [(180, 5.20), (300, 4.90), (600, 4.50), (1200, 4.20), (1800, 4.05), (2700, 3.95), (3600, 3.90)],
    )

    model = fit_speed_duration_model(envelope, as_of)

    assert model.riegel_k is not None and model.riegel_k > 0.08  # steep decay
    assert model.d_prime_m is not None and model.d_prime_m > 100  # large anaerobic reserve
    assert model.speed_index is not None and model.speed_index > 0.4
    assert model.endurance_index is not None and model.endurance_index < 0.3


def test_cs_model_recovers_known_cs_dprime():
    as_of = date(2026, 6, 27)
    cs_true, d_prime_true = 4.0, 200.0
    # Synthetic points exactly on distance = CS*t + D' within the 2-20min domain.
    points = [(t, (cs_true * t + d_prime_true) / t) for t in (120, 300, 600, 1200)]
    envelope = _envelope(as_of, points)

    model = fit_speed_duration_model(envelope, as_of)

    assert model.critical_speed_mps == pytest.approx(cs_true, abs=0.15)
    assert model.d_prime_m == pytest.approx(d_prime_true, abs=40)


# --- Phase 1.4 — recency / confidence weighting -----------------------------


def test_recent_efforts_dominate_curve_fit():
    as_of = date(2026, 6, 27)
    # Recent steep block vs a ~13-month-old flat block. Recency decay should make
    # the curve reflect current (steep) form, not the stale flat efforts.
    envelope = {
        300.0: _cand(as_of, duration_s=300, speed_mps=5.0, days_ago=3, label="recent_5m"),
        1200.0: _cand(as_of, duration_s=1200, speed_mps=4.0, days_ago=3, label="recent_20m"),
        600.0: _cand(as_of, duration_s=600, speed_mps=4.40, days_ago=400, label="stale_10m"),
        1800.0: _cand(as_of, duration_s=1800, speed_mps=4.35, days_ago=400, label="stale_30m"),
    }

    model = fit_speed_duration_model(envelope, as_of)

    assert model.riegel_k is not None and model.riegel_k > 0.07
    assert model.endurance_index is not None and model.endurance_index < 0.4


# --- Phase 1.5 — insufficient data falls back -------------------------------


def test_insufficient_buckets_yields_no_k_and_low_confidence():
    as_of = date(2026, 6, 27)
    envelope = _envelope(as_of, [(600, 4.30), (1200, 4.20)])  # only 2 buckets

    model = fit_speed_duration_model(envelope, as_of)

    assert model.riegel_k is None  # < 3 buckets → no trustworthy exponent
    assert model.confidence == CalibrationConfidence.LOW


def test_single_activity_subwindows_do_not_certify_flat_curve():
    """All buckets sharing one label (sub-windows of one steady run) must not be
    trusted as a flat speed-duration curve — confidence stays LOW so the caller
    keeps the population default exponent."""
    as_of = date(2026, 6, 27)
    envelope = {
        float(d): _cand(as_of, duration_s=d, speed_mps=4.2, label="one_steady_run")
        for d in (180, 300, 600, 1200, 1800)
    }

    model = fit_speed_duration_model(envelope, as_of)

    # Sub-windows collapse to a single maximal bucket → no trustworthy curve.
    assert model.riegel_k is None
    assert model.confidence in (CalibrationConfidence.LOW, CalibrationConfidence.NONE)


def test_one_bucket_falls_back_to_prior():
    as_of = date(2026, 6, 27)
    prior = ModelPrior(cs_mps=3.6, d_prime_m=150.0, riegel_k=0.055, strength_tau=4.0)
    envelope = _envelope(as_of, [(1200, 4.2)])

    model = fit_speed_duration_model(envelope, as_of, prior=prior)

    assert model.riegel_k == pytest.approx(0.055, abs=1e-6)
    assert model.confidence == CalibrationConfidence.LOW


# --- Phase 2 (pure side) — empirical-Bayes shrinkage ------------------------


def test_shrinkage_pulls_sparse_user_toward_prior():
    as_of = date(2026, 6, 27)
    prior = ModelPrior(cs_mps=3.5, d_prime_m=150.0, riegel_k=0.06, strength_tau=5.0)
    sparse = _envelope(as_of, [(180, 5.0), (300, 4.8), (600, 4.4)])  # short, light weight

    indiv = fit_speed_duration_model(sparse, as_of)
    shrunk = fit_speed_duration_model(sparse, as_of, prior=prior)

    assert indiv.riegel_k is not None and shrunk.riegel_k is not None
    assert abs(shrunk.riegel_k - prior.riegel_k) < abs(indiv.riegel_k - prior.riegel_k)


def test_shrinkage_barely_moves_data_rich_user():
    as_of = date(2026, 6, 27)
    prior = ModelPrior(cs_mps=3.0, d_prime_m=100.0, riegel_k=0.02, strength_tau=2.0)
    rich = _envelope(
        as_of,
        [(180, 5.2), (300, 4.9), (600, 4.5), (1200, 4.2), (1800, 4.05), (2700, 3.95), (3600, 3.9)],
    )

    indiv = fit_speed_duration_model(rich, as_of)
    shrunk = fit_speed_duration_model(rich, as_of, prior=prior)

    assert indiv.riegel_k is not None and shrunk.riegel_k is not None
    assert abs(shrunk.riegel_k - indiv.riegel_k) < abs(shrunk.riegel_k - prior.riegel_k)


# --- Phase 3 — race prediction + durability ---------------------------------


def _fixed_model() -> SpeedDurationModel:
    return SpeedDurationModel(
        critical_speed_mps=4.0,
        d_prime_m=200.0,
        riegel_k=0.05,
        endurance_index=0.6,
        speed_index=0.5,
        confidence=CalibrationConfidence.HIGH,
    )


def test_predict_race_matches_cs_dprime_hyperbola():
    model = _fixed_model()
    p10 = predict_race(model, 10000)
    assert p10 is not None
    # t = (10000 - 200) / 4.0 = 2450 s
    assert p10.time_s == pytest.approx(2450, abs=5)


def test_predictions_monotonic_in_distance():
    model = _fixed_model()
    p5 = predict_race(model, 5000)
    p10 = predict_race(model, 10000)
    phalf = predict_race(model, 21097)
    assert p5 and p10 and phalf
    assert p5.pace_s_per_km < p10.pace_s_per_km < phalf.pace_s_per_km


def test_predict_race_returns_none_without_cs():
    model = SpeedDurationModel(
        critical_speed_mps=None,
        d_prime_m=None,
        riegel_k=0.06,
        endurance_index=None,
        speed_index=None,
        confidence=CalibrationConfidence.LOW,
    )
    assert predict_race(model, 10000) is None


def test_marathon_applies_durability_discount():
    history = [
        RunningActivity(
            label_id="long_run",
            activity_date=date(2026, 6, 1),
            sport="run_outdoor",
            distance_m=20000,
        )
    ]
    over = durability_factor(history, decoupling=0.1, distance_m=42195)
    assert over > 1.0

    within = durability_factor(history, decoupling=None, distance_m=10000)
    assert within == 1.0  # well under the longest long run


def test_durability_factor_is_capped():
    factor = durability_factor([], decoupling=0.5, distance_m=42195)
    assert 1.0 <= factor <= 1.25
