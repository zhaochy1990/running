from __future__ import annotations

import json
import sqlite3
from datetime import date

import pytest

from stride_core.db import Database
from stride_core.models import ActivityDetail, TimeseriesPoint
from stride_core.running_calibration.sqlite_connector import SQLiteRunningCalibrationRepository
from stride_core.running_calibration.types import CalibrationConfidence, RunningCalibrationSnapshot


def _activity(
    label_id: str,
    date_iso: str = "2026-05-01T00:00:00+00:00",
    *,
    duration_s: int = 3600,
    distance_m: float = 14.4,
    avg_hr: int = 168,
    max_hr: int = 184,
) -> ActivityDetail:
    return ActivityDetail(
        label_id=label_id,
        name="Threshold Run",
        sport_type=100,
        sport_name="Run",
        date=date_iso,
        # Exercise connector normalization for legacy rows that store km in a
        # column named distance_m.
        distance_m=distance_m,
        duration_s=duration_s,
        avg_pace_s_km=250.0,
        adjusted_pace=None,
        best_km_pace=None,
        max_pace=None,
        avg_hr=avg_hr,
        max_hr=max_hr,
        avg_cadence=180,
        max_cadence=None,
        avg_power=None,
        max_power=None,
        avg_step_len_cm=None,
        ascent_m=None,
        descent_m=None,
        calories_kcal=None,
        aerobic_effect=None,
        anaerobic_effect=None,
        training_load=None,
        vo2max=None,
        performance=None,
        train_type="Threshold",
        temperature=None,
        humidity=None,
        feels_like=None,
        wind_speed=None,
        sport="run_outdoor",
        train_kind="threshold",
        timeseries=[
            TimeseriesPoint(
                timestamp=t * 100,
                distance=4.0 * t * 100.0,
                heart_rate=avg_hr,
                speed=250.0,
                adjusted_pace=None,
                cadence=180,
                altitude=0.0,
                power=None,
            )
            for t in range(0, duration_s + 1, 60)
        ],
    )


def test_sqlite_connector_fetches_history_with_normalized_units(db: Database):
    db.upsert_activity(_activity("run1"), provider="coros")
    repo = SQLiteRunningCalibrationRepository(db)

    history = repo.fetch_history(date(2026, 5, 1), date(2026, 5, 2))

    assert len(history) == 1
    activity = history[0]
    assert activity.activity_date.isoformat() == "2026-05-01"
    assert activity.distance_m == 14400.0
    assert activity.samples[-1].distance_m == 14400.0
    assert activity.samples[-1].speed_mps == pytest.approx(4.0)


def test_running_calibration_tables_created_by_connector_on_fresh_db(db: Database):
    SQLiteRunningCalibrationRepository(db)

    tables = {row["name"] for row in db.query("SELECT name FROM sqlite_master WHERE type='table'")}

    assert "running_calibration_snapshot" in tables
    assert "running_calibration_zone" in tables
    assert "running_calibration_evidence" in tables


def test_sqlite_connector_persists_snapshot_zones_and_evidence_idempotently(db: Database):
    repo = SQLiteRunningCalibrationRepository(db)
    snapshot = RunningCalibrationSnapshot(
        as_of_date=date(2026, 5, 1),
        threshold_hr=168.0,
        threshold_speed_mps=4.0,
        threshold_hr_confidence=CalibrationConfidence.HIGH,
        threshold_speed_confidence=CalibrationConfidence.HIGH,
        observed_max_hr=184.0,
        hrmax_estimate=184.0,
        hrmax_confidence=CalibrationConfidence.MEDIUM,
        high_hr_reference=172.0,
        source={"test": True},
    )

    first = repo.save_snapshot(snapshot)
    second = repo.save_snapshot(snapshot)

    assert second == first
    latest = repo.fetch_latest()
    assert latest is not None
    assert latest.id == first
    assert latest.threshold_hr == 168.0
    assert latest.threshold_speed_mps == 4.0
    assert latest.observed_max_hr == 184.0
    assert latest.hrmax_estimate == 184.0
    assert latest.hrmax_confidence == CalibrationConfidence.MEDIUM
    assert latest.high_hr_reference == 172.0
    row = db.query("SELECT source_json FROM running_calibration_snapshot WHERE id = ?", (first,))[0]
    assert json.loads(row["source_json"]) == {"test": True}
    assert db.query("SELECT COUNT(*) AS n FROM running_calibration_zone WHERE snapshot_id = ?", (first,))[0]["n"] > 0


def test_evidence_uniqueness_treats_null_bounds_as_duplicate(db: Database):
    repo = SQLiteRunningCalibrationRepository(db)
    snapshot_id = repo.save_snapshot(RunningCalibrationSnapshot(as_of_date=date(2026, 5, 1)))
    params = (
        snapshot_id,
        "threshold_speed",
        "activity_without_bounds",
        "2026-05-01",
        None,
        None,
        3600.0,
        4.0,
        None,
        "medium",
        "{}",
    )
    db._conn.execute(
        """INSERT INTO running_calibration_evidence
           (snapshot_id, kind, label_id, activity_date, start_s, end_s, duration_s,
            avg_speed_mps, avg_hr, confidence, source_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        params,
    )

    with pytest.raises(sqlite3.IntegrityError):
        db._conn.execute(
            """INSERT INTO running_calibration_evidence
               (snapshot_id, kind, label_id, activity_date, start_s, end_s, duration_s,
                avg_speed_mps, avg_hr, confidence, source_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            params,
        )


def test_running_calibration_tables_added_to_legacy_db(tmp_path):
    legacy_path = tmp_path / "legacy.db"
    conn = sqlite3.connect(str(legacy_path))
    conn.executescript(
        """
        CREATE TABLE activities (
            label_id TEXT PRIMARY KEY,
            name TEXT,
            sport_type INTEGER NOT NULL,
            sport_name TEXT,
            date TEXT NOT NULL,
            duration_s REAL,
            distance_m REAL
        );
        CREATE TABLE daily_health (date TEXT PRIMARY KEY, rhr INTEGER);
        """
    )
    conn.commit()
    conn.close()

    with Database(legacy_path) as db:
        repo = SQLiteRunningCalibrationRepository(db)
        repo.ensure_schema()
        tables = {row["name"] for row in db.query("SELECT name FROM sqlite_master WHERE type='table'")}

    assert "running_calibration_snapshot" in tables
    assert "running_calibration_zone" in tables
    assert "running_calibration_evidence" in tables


def test_sqlite_connector_supports_plain_sqlite_connection(tmp_path):
    path = tmp_path / "plain.db"
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    repo = SQLiteRunningCalibrationRepository(conn)

    snapshot_id = repo.save_snapshot(
        RunningCalibrationSnapshot(
            as_of_date=date(2026, 5, 1),
            threshold_hr=168.0,
            threshold_speed_mps=4.0,
            threshold_hr_confidence=CalibrationConfidence.HIGH,
            threshold_speed_confidence=CalibrationConfidence.HIGH,
        )
    )

    assert repo.fetch_latest().id == snapshot_id
    conn.close()


def test_persists_critical_power_w(tmp_path):
    db_path = tmp_path / "test.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    # Bare-minimum schema to satisfy the connector
    conn.executescript("""
        CREATE TABLE activities (label_id TEXT PRIMARY KEY, date TEXT, sport_name TEXT);
    """)
    db = type("DB", (), {"_conn": conn, "_path": str(db_path)})()
    repo = SQLiteRunningCalibrationRepository(db)
    snap = RunningCalibrationSnapshot(
        as_of_date=date(2026, 5, 20),
        critical_power_w=265.0,
        hrmax_estimate=185.0,
        threshold_hr=165.0,
        threshold_hr_confidence=CalibrationConfidence.MEDIUM,
        threshold_speed_confidence=CalibrationConfidence.MEDIUM,
        hrmax_confidence=CalibrationConfidence.MEDIUM,
    )
    snap_id = repo.save_snapshot(snap)
    row = conn.execute(
        "SELECT critical_power_w FROM running_calibration_snapshot WHERE id = ?",
        (snap_id,),
    ).fetchone()
    assert row["critical_power_w"] == 265.0


def test_schema_migration_adds_critical_power_w_column(tmp_path):
    """Simulate a legacy DB created before the migration."""
    db_path = tmp_path / "legacy.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE activities (label_id TEXT PRIMARY KEY, date TEXT);
        CREATE TABLE running_calibration_snapshot (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            as_of_date TEXT NOT NULL,
            algorithm_version INTEGER NOT NULL,
            threshold_hr_confidence TEXT NOT NULL,
            threshold_speed_confidence TEXT NOT NULL,
            hrmax_confidence TEXT NOT NULL DEFAULT 'none',
            UNIQUE(as_of_date, algorithm_version)
        );
    """)
    conn.commit()
    db = type("DB", (), {"_conn": conn, "_path": str(db_path)})()
    SQLiteRunningCalibrationRepository(db)  # ensure_schema runs in __init__
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(running_calibration_snapshot)").fetchall()}
    assert "critical_power_w" in cols


def test_fetch_health_rows_reads_daily_health(tmp_path):
    from datetime import date as _d
    from stride_core.running_calibration.types import RunningHealthRow
    db_path = tmp_path / "h.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE activities (label_id TEXT PRIMARY KEY, date TEXT);
        CREATE TABLE daily_health (date TEXT PRIMARY KEY, rhr INTEGER);
        INSERT INTO daily_health (date, rhr) VALUES
            ('20260501', 50),
            ('20260510', 48),
            ('20260520', 47),
            ('20260101', 60),
            ('20260515', NULL);
    """)
    db = type("DB", (), {"_conn": conn, "_path": str(db_path)})()
    repo = SQLiteRunningCalibrationRepository(db)
    rows = repo.fetch_health_rows(start=_d(2026, 2, 25), end=_d(2026, 5, 25))
    assert {r.date for r in rows} == {_d(2026, 5, 1), _d(2026, 5, 10), _d(2026, 5, 20)}
    assert all(isinstance(r, RunningHealthRow) for r in rows)
