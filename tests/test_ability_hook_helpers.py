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
