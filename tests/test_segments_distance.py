"""Tests for distance-based segment scan in running_calibration.segments."""
from __future__ import annotations

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
