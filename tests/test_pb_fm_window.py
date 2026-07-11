"""Regression: race-distance PB windows must admit GPS-long race measurements.

Real marathons/HMs measure LONG (tangents missed, certified-course minimum),
so a too-tight upper bound dropped the real race and let a shorter training run
at the exact nominal distance win the PB. See pb_records.ACTIVITY_DISTANCE_TOLERANCE_M.
"""
from __future__ import annotations

from stride_core.pb_records import _activity_level_candidates


def _fm(distance_km: float, dur_s: float):
    return _activity_level_candidates(
        {"distance_m": distance_km * 1000.0, "duration_s": dur_s, "name": "x"},
        "2026-03-21", "lbl", {"FM"},
    )


def test_fm_admits_gps_long_marathons():
    # The three real marathons that the old 42.4 km upper bound wrongly excluded.
    for km in (42.450, 42.518, 42.609):
        assert _fm(km, 10300.0), f"{km} km marathon should match FM"


def test_fm_still_admits_nominal_distance():
    assert _fm(42.222, 12000.0), "42.2 km should still match FM"


def test_fm_rejects_clearly_non_marathon_distance():
    assert not _fm(44.0, 11000.0), "44 km is too long to be a marathon effort"
    assert not _fm(41.0, 11000.0), "41 km is too short to be a marathon effort"


def test_hm_admits_gps_long_half():
    cands = _activity_level_candidates(
        {"distance_m": 21500.0, "duration_s": 5000.0, "name": "x"},
        "2026-04-12", "lbl", {"HM"},
    )
    assert cands, "21.5 km should match HM (GPS-long half marathon)"
