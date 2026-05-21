"""Verify training-load module now reads thresholds from running_calibration_snapshot."""
from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from stride_core.db import Database
from stride_core.running_calibration import (
    RUNNING_CALIBRATION_MODEL_VERSION,
    RunningCalibrationSnapshot,
    CalibrationConfidence,
)
from stride_core.running_calibration.sqlite_connector import SQLiteRunningCalibrationRepository
from stride_core.training_load.adapter import _fetch_latest_calibration


@pytest.fixture
def db_with_calibration(tmp_path: Path) -> Database:
    db_path = tmp_path / "test.db"
    db = Database(db_path)
    repo = SQLiteRunningCalibrationRepository(db)
    snapshot = RunningCalibrationSnapshot(
        as_of_date=date(2026, 5, 15),
        algorithm_version=RUNNING_CALIBRATION_MODEL_VERSION,
        threshold_hr=175.0,
        threshold_speed_mps=4.65,
        threshold_hr_confidence=CalibrationConfidence.MEDIUM,
        threshold_speed_confidence=CalibrationConfidence.MEDIUM,
        rhr_baseline=47.0,
        observed_max_hr=188.0,
        hrmax_estimate=188.0,
        hrmax_confidence=CalibrationConfidence.MEDIUM,
    )
    repo.save_snapshot(snapshot)
    return db


def test_training_load_reads_threshold_from_running_calibration_snapshot(db_with_calibration):
    calib = _fetch_latest_calibration(db_with_calibration)
    assert calib is not None
    assert calib.threshold_hr == 175.0
    assert calib.threshold_speed_mps == 4.65


def test_old_training_load_calibration_table_no_longer_exists(db_with_calibration):
    """Schema migration: training_load_calibration table is gone."""
    cur = db_with_calibration._conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='training_load_calibration'"
    )
    assert cur.fetchone() is None, "training_load_calibration should be dropped"
