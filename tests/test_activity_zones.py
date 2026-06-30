"""Tests for STRIDE-native per-activity time-in-zone (stride_core.activity_zones)."""

from __future__ import annotations

from datetime import date

from stride_core.activity_zones import (
    ZONE_INDEX,
    ZoneSample,
    compute_activity_time_in_zone,
    dwell_seconds,
)
from stride_core.running_calibration.types import RunningCalibrationSnapshot
from stride_core.running_calibration.zones import compute_training_zones


def _zone_set():
    snap = RunningCalibrationSnapshot(
        as_of_date=date(2026, 6, 1),
        threshold_speed_mps=4.0,
        threshold_hr=170.0,
    )
    zs = compute_training_zones(snap)
    return zs.pace_zones, zs.heart_rate_zones


def _by(rows, zone_type):
    return {r.zone_index: r for r in rows if r.zone_type == zone_type}


class TestComputeActivityTimeInZone:
    def test_classifies_and_accumulates_dwell(self):
        pace_zones, hr_zones = _zone_set()
        # speed 2.0 → recovery (idx1); speed 4.0 → threshold (idx4).
        # hr 120 → recovery (idx1); hr 175 → interval (idx5).
        samples = [
            ZoneSample(dwell_s=10, speed_mps=2.0, hr_bpm=120),
            ZoneSample(dwell_s=20, speed_mps=4.0, hr_bpm=175),
            ZoneSample(dwell_s=30, speed_mps=4.0, hr_bpm=175),
        ]
        rows = compute_activity_time_in_zone(samples, pace_zones, hr_zones)

        # recovery 10s, threshold 50s, total 60s → 16.7% / 83.3%.
        pace = _by(rows, "pace")
        assert len(pace) == 6
        assert pace[ZONE_INDEX["recovery"]].duration_s == 10
        assert pace[ZONE_INDEX["recovery"]].percent == 16.7
        assert pace[ZONE_INDEX["threshold"]].duration_s == 50
        assert pace[ZONE_INDEX["threshold"]].percent == 83.3
        assert pace[ZONE_INDEX["easy"]].duration_s == 0

        hr = _by(rows, "heartRate")
        assert hr[ZONE_INDEX["recovery"]].duration_s == 10
        assert hr[ZONE_INDEX["interval"]].duration_s == 50
        assert hr[ZONE_INDEX["interval"]].percent == 83.3

    def test_pace_bounds_are_ms_per_km_and_open_at_edges(self):
        pace_zones, hr_zones = _zone_set()
        rows = compute_activity_time_in_zone([], pace_zones, hr_zones)
        pace = _by(rows, "pace")

        recovery = pace[ZONE_INDEX["recovery"]]
        assert recovery.range_unit == "pace"
        # recovery's slow edge is open; its fast edge is 1000/(0.72*4.0) s/km in ms
        assert recovery.range_max is None
        assert recovery.range_min == round(1000 / (0.72 * 4.0) * 1000)

        repetition = pace[ZONE_INDEX["repetition"]]
        assert repetition.range_min is None
        assert repetition.range_max is not None

    def test_hr_recovery_open_low_edge(self):
        pace_zones, hr_zones = _zone_set()
        rows = compute_activity_time_in_zone([], pace_zones, hr_zones)
        hr = _by(rows, "heartRate")
        assert hr[ZONE_INDEX["recovery"]].range_min is None
        assert hr[ZONE_INDEX["recovery"]].range_unit == "bpm"
        assert hr[ZONE_INDEX["repetition"]].range_max is None

    def test_speed_only_activity_yields_no_hr_time(self):
        # Treadmill without an HR strap: pace classified, HR rows all zero.
        pace_zones, hr_zones = _zone_set()
        samples = [ZoneSample(dwell_s=60, speed_mps=4.0, hr_bpm=None)]
        rows = compute_activity_time_in_zone(samples, pace_zones, hr_zones)
        assert sum(r.duration_s for r in rows if r.zone_type == "heartRate") == 0
        assert _by(rows, "pace")[ZONE_INDEX["threshold"]].duration_s == 60

    def test_percent_within_metric_sums_to_100(self):
        pace_zones, hr_zones = _zone_set()
        samples = [
            ZoneSample(dwell_s=15, speed_mps=2.0, hr_bpm=120),
            ZoneSample(dwell_s=25, speed_mps=3.5, hr_bpm=155),
            ZoneSample(dwell_s=60, speed_mps=4.0, hr_bpm=175),
        ]
        rows = compute_activity_time_in_zone(samples, pace_zones, hr_zones)
        pace_pct = sum(r.percent for r in rows if r.zone_type == "pace")
        hr_pct = sum(r.percent for r in rows if r.zone_type == "heartRate")
        assert round(pace_pct) == 100
        assert round(hr_pct) == 100


class TestDwellSeconds:
    def test_uniform_cadence(self):
        assert dwell_seconds([0, 1, 2, 3]) == [1, 1, 1, 1]

    def test_pause_gap_clamped_to_median(self):
        # The 98s gap is a pause; it must not be counted as dwell.
        assert dwell_seconds([0, 1, 2, 100, 101]) == [1, 1, 1, 1, 1]

    def test_handles_too_few_points(self):
        assert dwell_seconds([5]) == [1.0]
        assert dwell_seconds([]) == []

    def test_aligns_one_to_one_with_input(self):
        # Must return exactly one dwell per input sample so the caller's zip onto
        # the samples stays paired — even when timestamps are missing (COROS drops
        # them during early GPS acquisition).
        elapsed = [0, 1, None, 3, 4]
        dwell = dwell_seconds(elapsed)
        assert len(dwell) == len(elapsed)
        assert all(d > 0 for d in dwell)

    def test_non_monotonic_gap_gets_median(self):
        # A backwards/zero step isn't a real dwell; fall back to the median.
        dwell = dwell_seconds([0, 1, 0, 2])
        assert len(dwell) == 4
        assert all(d > 0 for d in dwell)
