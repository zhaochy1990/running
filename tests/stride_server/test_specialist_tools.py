"""Tests for coach_adapters.specialist_tools (Stage-3a Task 3).

Covers the four specialist data functions:
- ``pace_targets``    — calibration snapshot + goal → PaceTargets
- ``volume_targets``  — pure weekly-volume budget (scaling + phase share)
- ``strength_library``— curated COROS T-code catalog + injury filter
- ``recent_training`` — running-row aggregation from the activities table
"""

from __future__ import annotations

from datetime import date

import pytest

from stride_core.db import Database
from stride_core.master_plan import PhaseType
from stride_core.running_calibration.sqlite_connector import (
    SQLiteRunningCalibrationRepository,
)
from stride_core.running_calibration.types import (
    CalibrationConfidence,
    RunningCalibrationSnapshot,
)
from stride_server.coach_adapters.specialist_tools import (
    pace_targets,
    recent_training,
    strength_library,
    volume_targets,
)

# threshold speed 4.0 m/s → threshold pace 250 s/km (4:10/km)
_THRESHOLD_SPEED_MPS = 4.0
_AS_OF = date(2026, 6, 1)


def _seed_calibration(db: Database, *, threshold_speed_mps: float | None = _THRESHOLD_SPEED_MPS,
                      threshold_hr: float | None = 168.0) -> None:
    repo = SQLiteRunningCalibrationRepository(db)
    repo.save_snapshot(
        RunningCalibrationSnapshot(
            as_of_date=date(2026, 5, 20),
            threshold_speed_mps=threshold_speed_mps,
            threshold_hr=threshold_hr,
            threshold_speed_confidence=CalibrationConfidence.HIGH,
            threshold_hr_confidence=CalibrationConfidence.HIGH,
            hrmax_confidence=CalibrationConfidence.NONE,
        )
    )


def _fm_goal(goal_time_s: int = 3 * 3600 + 30 * 60) -> dict:
    # 3:30:00 marathon
    return {"distance": "fm", "goal_time_s": goal_time_s, "race_date": "2026-11-01"}


# ---------------------------------------------------------------------------
# pace_targets
# ---------------------------------------------------------------------------


def test_pace_targets_fm_derives_mp_from_goal(db: Database):
    _seed_calibration(db)
    goal = _fm_goal()
    pt = pace_targets(db, goal=goal, as_of=_AS_OF)

    # MP = goal_time_s / 42.195
    assert pt.marathon_pace_s_km == pytest.approx(goal["goal_time_s"] / 42.195, abs=0.5)
    # threshold pace = 1000 / threshold_speed_mps = 250
    assert pt.threshold_pace_s_km == pytest.approx(250.0, abs=0.5)


def test_pace_targets_intervals_faster_than_threshold(db: Database):
    _seed_calibration(db)
    pt = pace_targets(db, goal=_fm_goal(), as_of=_AS_OF)

    # interval (5k/VO2max) must be faster (smaller s/km) than threshold
    assert pt.interval_pace_s_km < pt.threshold_pace_s_km
    # reps faster still, in order: 400m < 1000m < interval
    assert pt.rep_1000m_s_km is not None and pt.rep_400m_s_km is not None
    assert pt.rep_400m_s_km < pt.rep_1000m_s_km <= pt.interval_pace_s_km
    # easy band is slower (larger s/km) than threshold, and ordered low<high
    assert pt.easy_pace_low_s_km < pt.easy_pace_high_s_km
    assert pt.easy_pace_low_s_km > pt.threshold_pace_s_km


def test_pace_targets_no_snapshot_raises(db: Database):
    # No calibration seeded
    with pytest.raises(ValueError):
        pace_targets(db, goal=_fm_goal(), as_of=_AS_OF)


def test_pace_targets_missing_threshold_raises(db: Database):
    _seed_calibration(db, threshold_speed_mps=None)
    with pytest.raises(ValueError):
        pace_targets(db, goal=_fm_goal(), as_of=_AS_OF)


def test_pace_targets_non_fm_goal_uses_threshold_derived_mp(db: Database):
    _seed_calibration(db)
    goal = {"distance": "10k", "goal_time_s": 40 * 60}
    pt = pace_targets(db, goal=goal, as_of=_AS_OF)
    # Non-FM: MP derived from threshold, must be slower than threshold pace.
    assert pt.marathon_pace_s_km > pt.threshold_pace_s_km


# ---------------------------------------------------------------------------
# volume_targets
# ---------------------------------------------------------------------------


def test_volume_targets_scales_with_weekly_km():
    big = volume_targets(100.0, PhaseType.BUILD, level=70.0)
    small = volume_targets(55.0, PhaseType.BUILD, level=45.0)

    assert big.long_run_km != small.long_run_km
    assert big.quality_km_budget != small.quality_km_budget
    assert big.long_run_km > small.long_run_km
    assert big.quality_km_budget > small.quality_km_budget


def test_volume_targets_long_run_within_35_pct():
    for wk in (40.0, 55.0, 80.0, 100.0, 120.0):
        for phase in PhaseType:
            vt = volume_targets(wk, phase, level=60.0)
            assert vt.long_run_km / wk <= 0.35 + 1e-9


def test_volume_targets_phase_quality_share():
    wk = 80.0
    base = volume_targets(wk, PhaseType.BASE, level=60.0)
    build = volume_targets(wk, PhaseType.BUILD, level=60.0)
    peak = volume_targets(wk, PhaseType.PEAK, level=60.0)
    recovery = volume_targets(wk, PhaseType.RECOVERY, level=60.0)

    assert base.quality_km_budget < build.quality_km_budget
    assert peak.quality_km_budget >= build.quality_km_budget
    assert recovery.quality_km_budget == pytest.approx(0.0, abs=1.0)


def test_volume_targets_components_sum_to_weekly():
    vt = volume_targets(80.0, PhaseType.BUILD, level=60.0)
    total = vt.long_run_km + vt.quality_km_budget + vt.easy_km
    assert total == pytest.approx(80.0, abs=0.5)


# ---------------------------------------------------------------------------
# strength_library
# ---------------------------------------------------------------------------


def test_strength_library_returns_tcoded_items():
    items = strength_library(["calf_eccentric", "core"], injuries=[])
    assert items
    for it in items:
        assert it["code"].startswith("T")
        assert it["name"]
        assert it["sets_reps"]


def test_strength_library_filters_knee_injury():
    # glute_med catalog includes squat/lunge variants that conflict with knee
    items = strength_library(["glute_med", "hip_stability"], injuries=["knee"])
    names = " ".join(it["name"].lower() for it in items)
    assert "squat" not in names
    assert "lunge" not in names
    # but non-conflicting glute work (bridge/clamshell) survives
    assert items


def test_strength_library_unknown_group_handled():
    items = strength_library(["totally_unknown_group"], injuries=[])
    assert items == []


# ---------------------------------------------------------------------------
# recent_training
# ---------------------------------------------------------------------------


def _insert_activity(db: Database, label_id: str, *, sport_type: int, date_iso: str,
                     distance_m: float, duration_s: float = 1800.0) -> None:
    db._conn.execute(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
        "VALUES (?, ?, ?, ?, ?)",
        (label_id, sport_type, date_iso, distance_m, duration_s),
    )
    db._conn.commit()


def test_recent_training_aggregates_running_rows(db: Database):
    # Two runs in the same Shanghai week, one km-stored (<500) one legacy meters.
    _insert_activity(db, "r1", sport_type=100, date_iso="2026-05-26T01:00:00Z", distance_m=10.0)  # 10 km
    _insert_activity(db, "r2", sport_type=8001, date_iso="2026-05-27T01:00:00Z", distance_m=15000.0)  # 15 km legacy
    # A cycling row that must be excluded
    _insert_activity(db, "c1", sport_type=200, date_iso="2026-05-28T01:00:00Z", distance_m=40.0)

    summary = recent_training(db, weeks=4, as_of=date(2026, 6, 1))
    total_km = sum(w["total_km"] for w in summary)
    total_sessions = sum(w["session_count"] for w in summary)

    assert total_km == pytest.approx(25.0, abs=0.1)  # 10 + 15, cycling excluded
    assert total_sessions == 2


def test_recent_training_empty_db(db: Database):
    summary = recent_training(db, weeks=4, as_of=date(2026, 6, 1))
    assert summary == []


def test_recent_training_unknown_filter_raises(db: Database):
    # A typo'd filter must raise, not silently return unfiltered data.
    with pytest.raises(ValueError):
        recent_training(db, weeks=4, as_of=date(2026, 6, 1), filter="longrun")
