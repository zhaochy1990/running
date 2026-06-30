"""Tests for GET /api/{user}/health — specifically that rhr_baseline is read
from the canonical running_calibration_snapshot table (not inline daily_health).
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"


@pytest.fixture
def app_client(tmp_path, monkeypatch):
    import stride_core.db as core_db_mod
    import stride_server.deps as deps_mod

    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)

    from stride_server.routes.health import router as health_router

    app = FastAPI()
    app.include_router(health_router)
    return TestClient(app, raise_server_exceptions=False), tmp_path


def _open_user_db(tmp_path):
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)

    from stride_storage.sqlite.database import Database

    return Database(user=USER_UUID)


def test_rhr_baseline_comes_from_calibration_snapshot(app_client):
    """rhr_baseline in GET /health must be sourced from running_calibration_snapshot,
    not from inline P10 aggregation over daily_health.

    Proof: daily_health is left empty (so inline aggregation would return None),
    but running_calibration_snapshot has rhr_baseline=42.  The endpoint must
    return rhr_baseline == 42.
    """
    client, tmp_path = app_client
    db = _open_user_db(tmp_path)
    try:
        # Seed the canonical snapshot table with a known rhr_baseline.
        # Leave daily_health empty — inline P10 would give None.
        from stride_storage.sqlite.calibration_connector import SQLiteRunningCalibrationRepository
        from stride_core.running_calibration.types import (
            CalibrationConfidence,
            RunningCalibrationSnapshot,
        )
        from datetime import date

        repo = SQLiteRunningCalibrationRepository(db)
        snap = RunningCalibrationSnapshot(
            as_of_date=date(2026, 5, 20),
            algorithm_version=1,
            threshold_hr=None,
            threshold_speed_mps=None,
            threshold_hr_confidence=CalibrationConfidence.NONE,
            threshold_speed_confidence=CalibrationConfidence.NONE,
            rhr_baseline=42.0,
            observed_max_hr=None,
            hrmax_estimate=None,
            hrmax_confidence=CalibrationConfidence.NONE,
            high_hr_reference=None,
            critical_power_w=None,
        )
        repo.save_snapshot(snap)
    finally:
        db.close()

    resp = client.get(f"/api/{USER_UUID}/health?days=30")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rhr_baseline"] == 42, (
        f"Expected rhr_baseline=42 from calibration snapshot, got {body['rhr_baseline']!r}. "
        "Route may still be using the inline daily_health P10 computation."
    )


def test_rhr_baseline_none_when_no_snapshot(app_client):
    """When no calibration snapshot exists yet (new user), rhr_baseline must be None
    and the route must not 500.
    """
    client, tmp_path = app_client
    # Create user dir + DB but seed nothing.
    _open_user_db(tmp_path).close()

    resp = client.get(f"/api/{USER_UUID}/health?days=30")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rhr_baseline"] is None
