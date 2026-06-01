"""Tests for distance-based segment scan in running_calibration.segments."""
from __future__ import annotations

import pytest

from stride_core.running_calibration.segments import (
    DistanceCandidate,
    best_distance_candidates,
)


CANONICAL = {"5K": 5000.0, "10K": 10000.0, "half": 21097.5, "full": 42195.0}


def _flat_ts(total_dist_m: float, total_dur_s: float, hz: float = 1.0):
    """Build an even-paced timeseries: (t_s, dist_m) tuples at given rate."""
    n = max(2, int(total_dur_s * hz) + 1)
    return [(i / hz, total_dist_m * (i / (n - 1))) for i in range(n)]


def test_total_distance_below_target_returns_empty():
    ts = _flat_ts(total_dist_m=3000.0, total_dur_s=900.0)
    out = best_distance_candidates(ts, pauses_s=[], canonical_distances=CANONICAL)
    assert out == {}


def test_exact_distance_match_returns_whole_activity():
    """5.0 km even-paced run for 19:30 → segment IS the whole activity."""
    ts = _flat_ts(total_dist_m=5000.0, total_dur_s=1170.0)
    out = best_distance_candidates(ts, pauses_s=[], canonical_distances={"5K": 5000.0})
    assert "5K" in out
    cand = out["5K"]
    assert cand.race_type == "5K"
    assert cand.distance_m == 5000.0
    assert cand.duration_s == pytest.approx(1170.0, abs=0.5)
    assert cand.start_s == pytest.approx(0.0, abs=0.5)


def test_embedded_fast_block_in_long_run():
    """13 km run; the middle 5 km between t=600s and t=1770s is at 3:54/km
    pace (1170s). Surrounding pace is slower. Sliding window should locate
    the embedded fast block."""
    points = []
    sections = [
        (0.0, 600.0, 0.0, 1840.0),
        (600.0, 1770.0, 1840.0, 6840.0),
        (1770.0, 4171.0, 6840.0, 13358.0),
    ]
    for (t0, t1, d0, d1) in sections:
        n = int(t1 - t0)
        for i in range(n):
            f = i / n
            points.append((t0 + i, d0 + (d1 - d0) * f))
    points.append((4171.0, 13358.0))

    out = best_distance_candidates(points, pauses_s=[], canonical_distances={"5K": 5000.0})
    assert "5K" in out
    cand = out["5K"]
    assert cand.duration_s == pytest.approx(1170.0, abs=5.0)
    assert cand.start_s == pytest.approx(600.0, abs=5.0)
    assert cand.end_s == pytest.approx(1770.0, abs=5.0)
