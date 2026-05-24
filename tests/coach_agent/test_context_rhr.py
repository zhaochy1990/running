"""Tests that _rhr_baseline reads from the canonical running_calibration reader."""

from __future__ import annotations

import sqlite3
import sys
import types
from datetime import date
from unittest.mock import MagicMock

import pytest

from stride_core.running_calibration.sqlite_connector import SQLiteRunningCalibrationRepository
from stride_core.running_calibration.types import (
    CalibrationConfidence,
    RunningCalibrationSnapshot,
)

# ---------------------------------------------------------------------------
# Minimal stubs so coach_agent.context can be imported without fastapi.
# These are only inserted if the real modules are not already present.
# ---------------------------------------------------------------------------
_STUB_KEYS = [
    "stride_server",
    "stride_server.content_store",
    "stride_server.deps",
    "stride_server.routes",
    "stride_server.routes.body_composition",
    "stride_server.routes.training_plan",
]


def _ensure_stubs():
    """Insert lightweight stubs for stride_server submodules (no-op if already imported)."""
    if "stride_server" not in sys.modules:
        ss = types.ModuleType("stride_server")
        sys.modules["stride_server"] = ss

    if "stride_server.content_store" not in sys.modules:
        cs = types.ModuleType("stride_server.content_store")
        cs._container_client = MagicMock()
        cs._container_client.cache_clear = MagicMock()
        cs.ACCOUNT_URL_ENV = "AZURE_BLOB_ACCOUNT_URL"
        cs.CONTAINER_ENV = "AZURE_BLOB_CONTAINER"
        cs.PREFIX_ENV = "AZURE_BLOB_PREFIX"
        cs.read_text = MagicMock(return_value=None)
        sys.modules["stride_server.content_store"] = cs

    if "stride_server.deps" not in sys.modules:
        deps = types.ModuleType("stride_server.deps")
        deps.PROJECT_ROOT = MagicMock()
        deps.format_duration = MagicMock(return_value="0:00")
        deps.parse_week_dates = MagicMock(return_value=None)
        sys.modules["stride_server.deps"] = deps

    if "stride_server.routes" not in sys.modules:
        sys.modules["stride_server.routes"] = types.ModuleType("stride_server.routes")

    if "stride_server.routes.body_composition" not in sys.modules:
        bc = types.ModuleType("stride_server.routes.body_composition")
        bc.PHASE_CHECKPOINTS = []
        sys.modules["stride_server.routes.body_composition"] = bc

    if "stride_server.routes.training_plan" not in sys.modules:
        tp = types.ModuleType("stride_server.routes.training_plan")
        tp.get_training_plan = MagicMock(return_value={"content": None})
        sys.modules["stride_server.routes.training_plan"] = tp


_ensure_stubs()

# Now safe to import _rhr_baseline from the context module.
from coach_agent.context import _rhr_baseline  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_db(tmp_path):
    """Return a duck-typed DB object compatible with SQLiteRunningCalibrationRepository."""
    db_path = tmp_path / "ctx.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    db = type("DB", (), {
        "_conn": conn,
        "_path": str(db_path),
        "query": lambda self, *a, **k: [],
    })()
    return db


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_coach_context_reads_rhr_from_running_calibration(tmp_path):
    """_rhr_baseline must return the value from running_calibration_snapshot,
    NOT compute a fresh P10 from daily_health rows."""
    db = _make_db(tmp_path)

    repo = SQLiteRunningCalibrationRepository(db)
    repo.save_snapshot(RunningCalibrationSnapshot(
        as_of_date=date(2026, 5, 20),
        rhr_baseline=44.0,
        threshold_hr_confidence=CalibrationConfidence.NONE,
        threshold_speed_confidence=CalibrationConfidence.NONE,
        hrmax_confidence=CalibrationConfidence.NONE,
    ))

    # daily_health is empty — if _rhr_baseline still used the old SQL it
    # would return None (< 14 rows). Returning 44 proves the reader is used.
    assert _rhr_baseline(db) == 44


def test_coach_context_rhr_returns_none_when_no_snapshot(tmp_path):
    """_rhr_baseline returns None when running_calibration_snapshot has no rows."""
    db = _make_db(tmp_path)
    SQLiteRunningCalibrationRepository(db)  # ensure schema is created

    assert _rhr_baseline(db) is None


def test_coach_context_rhr_returns_int_not_float(tmp_path):
    """_rhr_baseline must return int, not float (float rhr_baseline is truncated)."""
    db = _make_db(tmp_path)

    repo = SQLiteRunningCalibrationRepository(db)
    repo.save_snapshot(RunningCalibrationSnapshot(
        as_of_date=date(2026, 5, 20),
        rhr_baseline=47.8,
        threshold_hr_confidence=CalibrationConfidence.NONE,
        threshold_speed_confidence=CalibrationConfidence.NONE,
        hrmax_confidence=CalibrationConfidence.NONE,
    ))

    result = _rhr_baseline(db)
    assert result == 47
    assert isinstance(result, int)
