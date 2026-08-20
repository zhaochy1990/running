"""Unit tests for the rule-based weekly session generator.

Focus: pace targets must come from the athlete's running-calibration pace zones
when available, and fall back to generic literals only when no calibration
exists. Regression guard for the bug where tempo (T) and interval (I) sessions
were stamped with hard-coded paces that matched the aerobic/easy zone.
"""

from __future__ import annotations

from datetime import date

from stride_core.running_calibration.types import (
    CalibrationConfidence,
    RunningCalibrationSnapshot,
)
from stride_core.running_calibration.zones import compute_training_zones
from stride_server.week_generator import generate_week_plan

# Monday.
_WEEK_START = date(2026, 7, 27)

# Threshold pace 4:30/km → 270 s/km → 3.7037 m/s.
_THRESHOLD_SPEED_MPS = 1000.0 / 270.0


def _summary_for(plan, marker: str) -> str:
    return next(s.summary for s in plan.sessions if s.summary.startswith(marker))


def _pace_zone_map():
    snapshot = RunningCalibrationSnapshot(
        as_of_date=date(2026, 7, 20),
        threshold_speed_mps=_THRESHOLD_SPEED_MPS,
        threshold_speed_confidence=CalibrationConfidence.HIGH,
    )
    zones = compute_training_zones(snapshot)
    return {zone.name: zone for zone in zones.pace_zones}


def test_calibrated_zones_drive_tempo_and_interval_paces() -> None:
    plan, _ = generate_week_plan(
        user_id="u1",
        week_start=_WEEK_START,
        base_distance_km=100.0,
        last_week_summary=None,
        pace_zones=_pace_zone_map(),
    )

    tempo = _summary_for(plan, "T 节奏跑")
    interval = _summary_for(plan, "I 间歇跑")
    easy = _summary_for(plan, "E 轻松跑")

    # Threshold band for a 4:30/km threshold, straight from the calibration
    # ratios — NOT the old generic "4:45-5:00/km".
    assert "4:22-4:38/km" in tempo
    # Intervals must be FASTER than threshold, not the old "4:15-4:30/km" that
    # actually sat in the easy range.
    assert "4:03-4:22/km" in interval
    assert "5:21-6:15/km" in easy

    # The reported generic literals must be gone once calibrated.
    assert "4:45-5:00/km" not in tempo
    assert "4:15-4:30/km" not in interval


def test_interval_pace_faster_than_tempo_when_calibrated() -> None:
    """Ordering invariant: interval per-km faster than tempo faster than easy."""
    plan, _ = generate_week_plan(
        user_id="u1",
        week_start=_WEEK_START,
        base_distance_km=100.0,
        last_week_summary=None,
        pace_zones=_pace_zone_map(),
    )

    def pace_s_per_km(marker: str) -> float:
        session = next(
            s for s in plan.sessions if s.summary.startswith(marker)
        )
        km = float(session.total_distance_m or 0) / 1000.0
        return float(session.total_duration_s or 0) / km

    assert pace_s_per_km("I 间歇跑") < pace_s_per_km("T 节奏跑")
    assert pace_s_per_km("T 节奏跑") < pace_s_per_km("E 轻松跑")


def test_falls_back_to_generic_paces_without_calibration() -> None:
    plan, _ = generate_week_plan(
        user_id="u1",
        week_start=_WEEK_START,
        base_distance_km=100.0,
        last_week_summary=None,
        pace_zones=None,
    )

    assert "4:45-5:00/km" in _summary_for(plan, "T 节奏跑")
    assert "4:15-4:30/km" in _summary_for(plan, "I 间歇跑")
    assert "5:30-6:00/km" in _summary_for(plan, "E 轻松跑")


def test_missing_zone_falls_back_per_day() -> None:
    """A partial zone map falls back only for the missing zones."""
    zones = _pace_zone_map()
    zones.pop("interval")  # simulate an absent interval band

    plan, _ = generate_week_plan(
        user_id="u1",
        week_start=_WEEK_START,
        base_distance_km=100.0,
        last_week_summary=None,
        pace_zones=zones,
    )

    # threshold still calibrated, interval falls back to the generic literal.
    assert "4:22-4:38/km" in _summary_for(plan, "T 节奏跑")
    assert "4:15-4:30/km" in _summary_for(plan, "I 间歇跑")
