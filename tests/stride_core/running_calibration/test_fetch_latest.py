"""Tests for fetch_latest() contract of SQLiteRunningCalibrationRepository.

This module locks in the behavior of fetch_latest() to ensure future refactors
and downstream consumers (ability snapshot, health route, coach context) don't
accidentally regress.
"""

from __future__ import annotations

from datetime import date

import pytest

from stride_storage.sqlite.database import Database
from stride_storage.sqlite.calibration_connector import SQLiteRunningCalibrationRepository
from stride_core.running_calibration.types import (
    CalibrationConfidence,
    RunningCalibrationSnapshot,
)


def _snap(
    as_of: str,
    hrmax: float = 185.0,
    algorithm_version: int = 3,
) -> RunningCalibrationSnapshot:
    """Helper to create a minimal snapshot for testing."""
    return RunningCalibrationSnapshot(
        as_of_date=date.fromisoformat(as_of),
        hrmax_estimate=hrmax,
        threshold_hr_confidence=CalibrationConfidence.NONE,
        threshold_speed_confidence=CalibrationConfidence.NONE,
        hrmax_confidence=CalibrationConfidence.MEDIUM,
        algorithm_version=algorithm_version,
    )


def test_fetch_latest_returns_none_when_empty(db: Database):
    """fetch_latest() should return None when no snapshots exist."""
    repo = SQLiteRunningCalibrationRepository(db)
    assert repo.fetch_latest() is None
    assert repo.fetch_latest(as_of_date=date(2026, 5, 1)) is None


def test_fetch_latest_returns_most_recent(db: Database):
    """fetch_latest() without as_of_date should return the snapshot with
    the latest as_of_date (and latest insertion id for ties).
    """
    repo = SQLiteRunningCalibrationRepository(db)
    repo.save_snapshot(_snap("2026-05-01", hrmax=180.0))
    repo.save_snapshot(_snap("2026-05-10", hrmax=185.0))
    repo.save_snapshot(_snap("2026-05-20", hrmax=190.0))

    result = repo.fetch_latest()

    assert result is not None
    assert result.hrmax_estimate == 190.0
    assert result.as_of_date == date(2026, 5, 20)


def test_fetch_latest_respects_as_of_date(db: Database):
    """fetch_latest(as_of_date=X) should return the latest snapshot where
    as_of_date <= X, not including snapshots after X.
    """
    repo = SQLiteRunningCalibrationRepository(db)
    repo.save_snapshot(_snap("2026-05-01", hrmax=180.0))
    repo.save_snapshot(_snap("2026-05-10", hrmax=185.0))
    repo.save_snapshot(_snap("2026-05-20", hrmax=190.0))

    result = repo.fetch_latest(as_of_date=date(2026, 5, 15))

    assert result is not None
    assert result.hrmax_estimate == 185.0
    assert result.as_of_date == date(2026, 5, 10)


def test_fetch_nearest_hrmax_uses_latest_prior_snapshot(db: Database):
    repo = SQLiteRunningCalibrationRepository(db)
    repo.save_snapshot(_snap("2026-05-01", hrmax=180.0))
    repo.save_snapshot(_snap("2026-05-10", hrmax=185.0))
    repo.save_snapshot(_snap("2026-05-20", hrmax=190.0))

    result = repo.fetch_nearest_hrmax(date(2026, 5, 15))

    assert result is not None
    assert result.hrmax_estimate == 185.0
    assert result.as_of_date == date(2026, 5, 10)


def test_fetch_nearest_hrmax_falls_forward_before_first_snapshot(db: Database):
    repo = SQLiteRunningCalibrationRepository(db)
    repo.save_snapshot(_snap("2026-05-10", hrmax=185.0))
    repo.save_snapshot(_snap("2026-05-20", hrmax=190.0))

    result = repo.fetch_nearest_hrmax(date(2026, 5, 1))

    assert result is not None
    assert result.hrmax_estimate == 185.0
    assert result.as_of_date == date(2026, 5, 10)


def test_fetch_nearest_hrmax_skips_snapshots_without_hrmax(db: Database):
    repo = SQLiteRunningCalibrationRepository(db)
    repo.save_snapshot(RunningCalibrationSnapshot(
        as_of_date=date(2026, 5, 1),
        hrmax_estimate=None,
        threshold_hr_confidence=CalibrationConfidence.NONE,
        threshold_speed_confidence=CalibrationConfidence.NONE,
        hrmax_confidence=CalibrationConfidence.NONE,
    ))
    repo.save_snapshot(_snap("2026-05-10", hrmax=185.0))

    result = repo.fetch_nearest_hrmax(date(2026, 5, 1))

    assert result is not None
    assert result.hrmax_estimate == 185.0
    assert result.as_of_date == date(2026, 5, 10)


def test_fetch_latest_ignores_noncanonical_algorithm_version(db: Database):
    repo = SQLiteRunningCalibrationRepository(db)
    # Same as_of_date, two algorithm versions inserted in version order
    repo.save_snapshot(_snap("2026-05-20", hrmax=190.0, algorithm_version=3))
    repo.save_snapshot(_snap("2026-05-21", hrmax=220.0, algorithm_version=99))

    result = repo.fetch_latest()

    assert result is not None
    assert result.hrmax_estimate == 190.0
    assert result.algorithm_version == 3


def test_fetch_latest_preserves_critical_power_w(db: Database):
    """Regression guard: Task 5 added critical_power_w to the schema and
    hydration path; fetch_latest must round-trip the value.
    """
    repo = SQLiteRunningCalibrationRepository(db)
    snap = RunningCalibrationSnapshot(
        as_of_date=date(2026, 5, 20),
        critical_power_w=265.0,
        threshold_hr_confidence=CalibrationConfidence.NONE,
        threshold_speed_confidence=CalibrationConfidence.NONE,
        hrmax_confidence=CalibrationConfidence.NONE,
    )
    repo.save_snapshot(snap)

    result = repo.fetch_latest()

    assert result is not None
    assert result.critical_power_w == 265.0
