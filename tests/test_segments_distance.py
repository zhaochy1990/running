"""Tests for distance-based segment scan in running_calibration.segments."""
from __future__ import annotations

import pytest

from stride_core.ability import compute_pb_vdot_for_segment
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


def test_pause_overlaps_fastest_segment_returns_next_best():
    """13 km activity with embedded fast 5K at 600..1770s.
    Pause inserted at 1000..1100s (inside the fast block) → algorithm picks
    the next-best non-overlapping 5K window (somewhere in cooldown)."""
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

    out = best_distance_candidates(
        points,
        pauses_s=[(1000.0, 1100.0)],
        canonical_distances={"5K": 5000.0},
    )
    assert "5K" in out
    cand = out["5K"]
    # Picked segment must NOT contain the pause window
    assert not (cand.start_s < 1100.0 and cand.end_s > 1000.0)
    # Cooldown is slower → duration > 1170s
    assert cand.duration_s > 1170.0


def test_pause_at_segment_boundary_is_not_overlap():
    """Pause ending exactly at the fast-segment start should NOT disqualify."""
    ts = _flat_ts(total_dist_m=5000.0, total_dur_s=1170.0)
    out = best_distance_candidates(
        ts,
        pauses_s=[(-100.0, 0.0)],  # ends exactly at segment start
        canonical_distances={"5K": 5000.0},
    )
    assert "5K" in out


def test_all_segments_blocked_by_pauses_returns_empty():
    """Pauses chop the activity so no continuous 5km segment survives."""
    ts = _flat_ts(total_dist_m=8000.0, total_dur_s=1800.0)
    out = best_distance_candidates(
        ts,
        pauses_s=[(300.0, 400.0), (700.0, 800.0), (1100.0, 1200.0), (1500.0, 1600.0)],
        canonical_distances={"5K": 5000.0},
    )
    # Each unbroken sub-interval is shorter than what 5km needs at this pace
    # (~4.44 m/s, 5km would take ~1125s; longest unbroken slice is 400s).
    assert "5K" not in out


def test_non_monotonic_distance_does_not_crash():
    """GPS noise: distance occasionally regresses. Algorithm must not raise."""
    ts = [(0.0, 0.0), (60.0, 200.0), (120.0, 190.0), (180.0, 400.0), (240.0, 600.0)]
    out = best_distance_candidates(ts, pauses_s=[], canonical_distances={"5K": 5000.0})
    assert out == {}


def test_marathon_in_ultra_finds_full():
    """50 km activity at constant pace contains a 42195 m segment."""
    ts = _flat_ts(total_dist_m=50000.0, total_dur_s=18000.0)
    out = best_distance_candidates(ts, pauses_s=[], canonical_distances={"full": 42195.0})
    assert "full" in out
    assert out["full"].distance_m == 42195.0


def test_short_marathon_under_canonical_dropped():
    """41.5 km activity does NOT yield a `full` candidate."""
    ts = _flat_ts(total_dist_m=41500.0, total_dur_s=15000.0)
    out = best_distance_candidates(ts, pauses_s=[], canonical_distances={"full": 42195.0})
    assert "full" not in out


def test_multiple_race_types_one_pass():
    """13 km activity should yield candidates for both 5K and 10K."""
    ts = _flat_ts(total_dist_m=13000.0, total_dur_s=4000.0)
    out = best_distance_candidates(
        ts,
        pauses_s=[],
        canonical_distances={"5K": 5000.0, "10K": 10000.0, "half": 21097.5},
    )
    assert "5K" in out and "10K" in out
    assert "half" not in out  # 13 km < 21097.5 m


def test_vdot_for_segment_5k_known_pace():
    """19:30 over 5000 m via Daniels — VDOT in mid-50s ballpark."""
    vdot = compute_pb_vdot_for_segment("5K", 5000.0, 1170.0)
    assert vdot is not None
    assert 48.0 < vdot < 55.0


def test_vdot_for_segment_marathon_uses_table():
    """2:59:22 marathon — goes via the table, not Daniels formula."""
    vdot = compute_pb_vdot_for_segment("full", 42195.0, 10762.0)
    assert vdot is not None
    assert 50.0 < vdot < 60.0


def test_vdot_for_segment_invalid_distance_or_time_is_none():
    assert compute_pb_vdot_for_segment("5K", 0.0, 1170.0) is None
    assert compute_pb_vdot_for_segment("5K", 5000.0, 0.0) is None
    assert compute_pb_vdot_for_segment("5K", -1.0, 1170.0) is None


def test_vdot_for_segment_marathon_time_out_of_table_returns_none():
    """An impossibly fast marathon (60 minutes) returns None from the table."""
    vdot = compute_pb_vdot_for_segment("full", 42195.0, 3600.0)
    assert vdot is None
