"""Tests for _parse_pauses and _normalize_ts_units in ability_hook.

Real COROS data uses absolute centi-second ticks for timestamps and
centimeters for distance. The 2022-11-27 activity 448162183159775233
has a real pause: start_ts=166953421795, end_ts=166953421906, type=0.
"""
from __future__ import annotations

from stride_core.ability_hook import _parse_pauses, _normalize_ts_units


def _row(ts, dist):
    """Mimic a sqlite3.Row via a dict (dict access works the same)."""
    return {"timestamp": ts, "distance": dist}


def test_normalize_ts_units_converts_centi_seconds_and_centimeters():
    """COROS units: timestamp /100 → seconds; distance /100 → meters.
    t_s is activity-relative (subtract first timestamp)."""
    rows = [_row(177987904200, 0), _row(177987904300, 400), _row(177987905200, 4000)]
    out = _normalize_ts_units(rows)
    assert out[0] == (0.0, 0.0)
    assert out[1] == (1.0, 4.0)        # 0.01s, 4 cm
    assert out[2] == (10.0, 40.0)


def test_normalize_ts_units_keeps_meter_distances_when_activity_total_matches():
    """Garmin stores timestamp as centiseconds but distance as meters.
    When the activity total is also around 5km, the distance must not be
    divided by 100 or a real 5K segment disappears.
    """
    rows = [_row(0, 0.0), _row(60_000, 3000.0), _row(100_000, 5000.0)]
    out = _normalize_ts_units(rows, activity_distance_m=5000.0)
    assert out == [(0.0, 0.0), (600.0, 3000.0), (1000.0, 5000.0)]


def test_normalize_ts_units_filters_nulls():
    rows = [_row(100, 0), _row(None, 50), _row(200, None), _row(300, 100)]
    out = _normalize_ts_units(rows)
    # First (100,0) and last (300,100) survive — both have non-null
    assert out == [(0.0, 0.0), (2.0, 1.0)]


def test_normalize_ts_units_empty_input():
    assert _normalize_ts_units([]) == []


def test_parse_pauses_none_returns_empty():
    assert _parse_pauses(None, t0=0) == []
    assert _parse_pauses("", t0=0) == []


def test_parse_pauses_converts_absolute_to_activity_relative_seconds():
    """Real format: {"start_ts": <centi-sec absolute>, "end_ts": <centi-sec abs>}.
    Subtract activity-start t0, divide by 100 → activity-relative seconds."""
    raw = '[{"start_ts": 166953421795, "end_ts": 166953421906, "type": 0}]'
    out = _parse_pauses(raw, t0=166953420000)
    assert len(out) == 1
    start_s, end_s = out[0]
    assert start_s == 17.95
    assert end_s == 19.06


def test_parse_pauses_drops_inverted_intervals():
    raw = '[{"start_ts": 100, "end_ts": 50, "type": 0}]'
    out = _parse_pauses(raw, t0=0)
    assert out == []


def test_parse_pauses_bad_json_returns_empty():
    assert _parse_pauses("not-json", t0=0) == []


def test_parse_pauses_missing_keys_returns_empty():
    raw = '[{"foo": 1}]'
    out = _parse_pauses(raw, t0=0)
    assert out == []


def test_normalize_ts_units_drops_distance_regression():
    """COROS sometimes emits a synthetic distance=0 sample at pause resume
    without recording the pause in activities.pauses. The reset sample is
    non-monotonic vs the previous accumulated distance; drop it so the
    segment scanner doesn't compute impossibly fast windows."""
    # COROS units: timestamp /100 → seconds, distance /100 → meters
    rows = [
        _row(100, 0),         # t=0,  d=0
        _row(200, 500_000),   # t=1,  d=5000m
        _row(300, 0),         # synthetic reset — DROP THIS
        _row(400, 505_000),   # t=3,  d=5050m (resumes)
        _row(500, 510_000),   # t=4,  d=5100m
    ]
    out = _normalize_ts_units(rows)
    # Reset sample (300, 0) dropped; remaining 4 points monotonic
    assert len(out) == 4
    distances = [d for _, d in out]
    assert distances == [0.0, 5000.0, 5050.0, 5100.0]


def test_normalize_ts_units_drops_minor_gps_regression():
    """Tiny GPS noise like 5000→4998→5001: drop the 4998 backward step
    but keep the next forward sample. Cumulative monotonicity preserved."""
    rows = [
        _row(100, 0),
        _row(200, 500_000),    # 5000
        _row(300, 499_800),    # 4998 — drop
        _row(400, 500_100),    # 5001 — keep, still forward vs the last KEPT 5000
    ]
    out = _normalize_ts_units(rows)
    assert len(out) == 3
    assert [d for _, d in out] == [0.0, 5000.0, 5001.0]


def test_normalize_ts_units_equal_distance_kept():
    """Equal-distance samples (idle / very slow) should NOT be dropped.
    The filter rule is strict regression (< previous), not <=."""
    rows = [_row(100, 0), _row(200, 1000), _row(300, 1000), _row(400, 2000)]
    out = _normalize_ts_units(rows)
    assert len(out) == 4
