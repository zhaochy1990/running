from __future__ import annotations

import json
import sqlite3
from datetime import date, timedelta

import pytest

from stride_storage.sqlite.database import Database
from stride_core.models import ActivityDetail, DailyHealth, DailyHrv, TimeseriesPoint
from stride_core.running_calibration import (
    RUNNING_CALIBRATION_MODEL_VERSION,
    CalibrationConfidence,
    RunningCalibrationSnapshot,
)
from stride_storage.sqlite.calibration_connector import SQLiteRunningCalibrationRepository
from stride_core.training_load.adapter import (
    _fetch_health_rows,
    _fetch_samples,
    _normalize_elapsed_seconds,
    backfill_training_load,
    refresh_training_load_calibration,
    recompute_training_load,
)
from stride_core.training_load.types import CalibrationSnapshot


def _save_running_snapshot(
    db,
    *,
    as_of_date: date,
    threshold_hr: float = 170.0,
    threshold_speed_mps: float = 4.0,
    rhr_baseline: float = 50.0,
    hrmax_estimate: float | None = 186.0,
    algorithm_version: int = RUNNING_CALIBRATION_MODEL_VERSION,
) -> int:
    """Helper to persist a RunningCalibrationSnapshot into running_calibration_snapshot."""
    repo = SQLiteRunningCalibrationRepository(db)
    snap = RunningCalibrationSnapshot(
        as_of_date=as_of_date,
        algorithm_version=algorithm_version,
        threshold_hr=threshold_hr,
        threshold_speed_mps=threshold_speed_mps,
        threshold_hr_confidence=CalibrationConfidence.MEDIUM,
        threshold_speed_confidence=CalibrationConfidence.MEDIUM,
        rhr_baseline=rhr_baseline,
        observed_max_hr=hrmax_estimate,
        hrmax_estimate=hrmax_estimate,
        hrmax_confidence=CalibrationConfidence.MEDIUM if hrmax_estimate is not None else CalibrationConfidence.NONE,
    )
    return repo.save_snapshot(snap)


def _make_activity(
    label_id: str,
    date_iso: str,
    *,
    sport_type: int = 100,
    sport: str | None = "run_outdoor",
    train_kind: str | None = "aerobic",
    duration_s: float = 3600,
    distance_m: float = 14400,
    avg_hr: int | None = 168,
    max_hr: int | None = 186,
    avg_power: int | None = 300,
    samples: list[TimeseriesPoint] | None = None,
) -> ActivityDetail:
    return ActivityDetail(
        label_id=label_id,
        name="Test Run",
        sport_type=sport_type,
        sport_name="Run",
        date=date_iso,
        distance_m=distance_m,
        duration_s=duration_s,
        avg_pace_s_km=250.0,
        adjusted_pace=None,
        best_km_pace=None,
        max_pace=None,
        avg_hr=avg_hr,
        max_hr=max_hr,
        avg_cadence=180,
        max_cadence=190,
        avg_power=avg_power,
        max_power=None,
        avg_step_len_cm=None,
        ascent_m=0.0,
        descent_m=0.0,
        calories_kcal=500,
        aerobic_effect=None,
        anaerobic_effect=None,
        training_load=999.0,
        vo2max=None,
        performance=None,
        train_type="Aerobic Endurance",
        temperature=None,
        humidity=None,
        feels_like=None,
        wind_speed=None,
        sport=sport,
        train_kind=train_kind,
        timeseries=samples or [],
    )


def _timeseries(
    duration_s: int = 3600,
    *,
    hr: int | None = 170,
    speed_mps: float | None = 4.0,
    distance_scale: float = 1.0,
) -> list[TimeseriesPoint]:
    return [
        TimeseriesPoint(
            timestamp=i * 100,
            distance=(speed_mps * i * distance_scale) if speed_mps is not None else None,
            heart_rate=hr,
            speed=(1000.0 / speed_mps) if speed_mps else None,
            adjusted_pace=None,
            cadence=180,
            altitude=0.0,
            power=None,
        )
        for i in range(0, duration_s + 1, 30)
    ]


def test_normalizes_coros_epoch_centisecond_timestamps_to_elapsed_seconds():
    rows = [
        {"timestamp": 177883874900},
        {"timestamp": 177883875000},
        {"timestamp": 177883875100},
    ]

    assert _normalize_elapsed_seconds(rows) == (0.0, 1.0, 2.0)


def test_fetch_samples_normalizes_provider_distance_units(db):
    db.upsert_activity(
        _make_activity(
            "coros_run",
            "2026-05-01T00:00:00+00:00",
            distance_m=14400,
            samples=_timeseries(speed_mps=4.0, distance_scale=100.0),
        ),
        provider="coros",
    )
    db.upsert_activity(
        _make_activity(
            "garmin_run",
            "2026-05-01T00:00:00+00:00",
            sport_type=8001,
            distance_m=14400,
            samples=_timeseries(speed_mps=4.0),
        ),
        provider="garmin",
    )

    coros_samples = _fetch_samples(db, "coros_run", provider="coros", sport_type=100)
    garmin_samples = _fetch_samples(db, "garmin_run", provider="garmin", sport_type=8001)

    assert coros_samples[-1].distance_m == 14400.0
    assert garmin_samples[-1].distance_m == 14400.0


def test_recompute_uses_activity_distance_stored_as_meters(db):
    db.upsert_daily_health(DailyHealth("2026-05-01", None, None, 50, None, None, None, None, None))
    db.upsert_activity(
        _make_activity(
            "km_run",
            "2026-05-01T00:00:00+00:00",
            distance_m=14400,
            avg_power=None,
            samples=_timeseries(hr=170, speed_mps=4.0, distance_scale=100.0),
        ),
        provider="coros",
    )

    refresh_training_load_calibration(db, as_of_date="2026-05-01")
    recompute_training_load(db, start="2026-05-01", end="2026-05-01")

    calibration = db.query("SELECT * FROM running_calibration_snapshot")[0]
    activity_row = db.fetch_activity_training_load("km_run")
    assert calibration["threshold_speed_mps"] == pytest.approx(4.0, rel=0.02)
    assert calibration["threshold_hr"] == pytest.approx(170.0, abs=2.0)
    assert activity_row["external_tss"] == pytest.approx(100.0, rel=0.05)
    # 14.4 km flat → grade_factor=1.0, descent_factor=1.0, intensity_factor ≈ 1.011
    # (normalized_IF ≈ 1.0 → 1 + 0.5*(0.15)^2). 14.4 * 1.011 ≈ 14.562.
    assert activity_row["mechanical_load"] == pytest.approx(14.562, rel=0.01)


def test_refresh_training_load_calibration_persists_weekly_threshold_snapshot(db):
    db.upsert_daily_health(DailyHealth("2026-05-01", None, None, 50, None, None, None, None, None))
    db.upsert_activity(
        _make_activity(
            "calibration_run",
            "2026-05-01T00:00:00+00:00",
            avg_power=None,
            samples=_timeseries(hr=170, speed_mps=4.0),
        ),
        provider="garmin",
    )

    calibration = refresh_training_load_calibration(db, as_of_date="2026-05-01")

    rows = db.query("SELECT * FROM running_calibration_snapshot")
    assert len(rows) == 1
    assert calibration.id == rows[0]["id"]
    assert calibration.threshold_speed_mps == pytest.approx(4.0, rel=0.02)
    assert calibration.threshold_hr == pytest.approx(170.0, abs=2.0)


def test_recompute_reuses_latest_running_calibration_snapshot(db):
    """When a running_calibration_snapshot exists, recompute_training_load uses it
    without calling estimate_running_calibration."""
    snapshot_id = _save_running_snapshot(
        db,
        as_of_date=date(2026, 5, 1),
        threshold_hr=170.0,
        threshold_speed_mps=4.0,
    )
    db.upsert_activity(
        _make_activity(
            "run1",
            "2026-05-03T00:00:00+00:00",
            avg_power=None,
            samples=_timeseries(hr=170, speed_mps=4.0),
        ),
        provider="garmin",
    )

    summary = recompute_training_load(db, start="2026-05-03", end="2026-05-03")

    assert summary.calibration_id == snapshot_id
    assert db.query("SELECT COUNT(*) AS n FROM running_calibration_snapshot")[0]["n"] == 1
    row = db.fetch_activity_training_load("run1")
    assert row is not None
    assert row["calibration_id"] == snapshot_id
    assert row["training_dose"] is not None


def test_recompute_ignores_calibration_snapshot_from_other_algorithm_version(db):
    """recompute_training_load only reads running_calibration_snapshot rows matching
    RUNNING_CALIBRATION_MODEL_VERSION; snapshots with other versions are ignored."""
    current_id = _save_running_snapshot(
        db,
        as_of_date=date(2026, 5, 1),
        threshold_hr=170.0,
        threshold_speed_mps=4.0,
        algorithm_version=RUNNING_CALIBRATION_MODEL_VERSION,
    )
    _save_running_snapshot(
        db,
        as_of_date=date(2026, 5, 2),
        threshold_hr=170.0,
        threshold_speed_mps=2.0,
        algorithm_version=99,
    )
    db.upsert_activity(
        _make_activity(
            "run1",
            "2026-05-03T00:00:00+00:00",
            avg_power=None,
            samples=_timeseries(hr=170, speed_mps=4.0),
        ),
        provider="garmin",
    )

    summary = recompute_training_load(db, start="2026-05-03", end="2026-05-03")

    assert summary.calibration_id == current_id
    row = db.fetch_activity_training_load("run1")
    assert row is not None
    assert row["calibration_id"] == current_id


def test_recompute_never_defaults_threshold_speed_from_activity_max(db):
    snapshot_id = _save_running_snapshot(
        db,
        as_of_date=date(2026, 5, 1),
        threshold_speed_mps=None,  # intentionally missing — forces runtime default
    )
    db.upsert_activity(
        _make_activity(
            "run1",
            "2026-05-03T00:00:00+00:00",
            avg_power=None,
            samples=_timeseries(hr=170, speed_mps=4.0),
        ),
        provider="garmin",
    )

    summary = recompute_training_load(db, start="2026-05-03", end="2026-05-03")

    assert summary.calibration_id == snapshot_id
    cached = db.query(
        "SELECT threshold_speed_mps FROM running_calibration_snapshot WHERE id = ?", (snapshot_id,)
    )[0]
    assert cached["threshold_speed_mps"] is None
    row = db.fetch_activity_training_load("run1")
    assert row is not None
    assert row["calibration_id"] == snapshot_id
    assert row["external_tss"] is None
    assert row["training_dose_source"] == "cardio"


def test_recompute_never_defaults_hrmax_from_activity_max(db):
    snapshot_id = _save_running_snapshot(
        db,
        as_of_date=date(2026, 5, 1),
        hrmax_estimate=None,  # intentionally missing — forces runtime default
    )
    db.upsert_activity(
        _make_activity(
            "run1",
            "2026-05-03T00:00:00+00:00",
            avg_power=None,
            max_hr=186,
            samples=_timeseries(hr=170, speed_mps=4.0),
        ),
        provider="garmin",
    )

    summary = recompute_training_load(db, start="2026-05-03", end="2026-05-03")

    assert summary.calibration_id == snapshot_id
    cached = db.query(
        "SELECT hrmax_estimate FROM running_calibration_snapshot WHERE id = ?", (snapshot_id,)
    )[0]
    assert cached["hrmax_estimate"] is None
    row = db.fetch_activity_training_load("run1")
    assert row is not None
    assert row["calibration_id"] == snapshot_id
    assert row["cardio_tss"] is None
    assert row["training_dose_source"] == "external"


def test_recompute_without_cached_calibration_does_not_create_running_snapshot(db):
    """recompute_training_load never writes a running_calibration_snapshot;
    it only reads one. Without a prior refresh, calibration_id stays None."""
    db.upsert_activity(
        _make_activity(
            "run1",
            "2026-05-03T00:00:00+00:00",
            samples=_timeseries(hr=170, speed_mps=4.0),
        ),
        provider="garmin",
    )

    summary = recompute_training_load(db, start="2026-05-03", end="2026-05-03")

    assert summary.calibration_id is None
    # running_calibration_snapshot is created by ensure_schema but stays empty
    assert db.query("SELECT COUNT(*) AS n FROM running_calibration_snapshot")[0]["n"] == 0
    row = db.fetch_activity_training_load("run1")
    assert row is not None
    assert row["training_dose"] is None
    assert row["coverage_status"] == "unknown"


def test_backfill_refreshes_calibration_then_recomputes_recent_load_window(db):
    db.upsert_daily_health(DailyHealth("2026-05-20", None, None, 50, None, None, None, None, None))
    db.upsert_activity(
        _make_activity(
            "old_run",
            "2026-01-01T00:00:00+00:00",
            avg_power=None,
            samples=_timeseries(hr=170, speed_mps=4.0),
        ),
        provider="garmin",
    )
    db.upsert_activity(
        _make_activity(
            "recent_run",
            "2026-05-20T00:00:00+00:00",
            avg_power=None,
            samples=_timeseries(hr=170, speed_mps=4.0),
        ),
        provider="garmin",
    )

    summary = backfill_training_load(db, as_of_date="2026-05-20", load_lookback_days=90)

    assert summary.calibration.id is not None
    assert summary.load.start == date(2026, 2, 19)
    assert summary.load.end == date(2026, 5, 20)
    assert db.fetch_activity_training_load("old_run") is None
    assert db.fetch_activity_training_load("recent_run") is not None


def test_backfill_persist_false_uses_refreshed_calibration_without_writes(db):
    """With persist=False, backfill computes a fresh calibration but writes nothing
    to running_calibration_snapshot; any existing stale snapshot stays unchanged."""
    stale_id = _save_running_snapshot(
        db,
        as_of_date=date(2026, 4, 1),
        threshold_speed_mps=2.0,
    )
    db.upsert_daily_health(DailyHealth("2026-05-20", None, None, 50, None, None, None, None, None))
    db.upsert_activity(
        _make_activity(
            "recent_run",
            "2026-05-20T00:00:00+00:00",
            avg_power=None,
            samples=_timeseries(hr=170, speed_mps=4.0),
        ),
        provider="garmin",
    )

    summary = backfill_training_load(
        db,
        as_of_date="2026-05-20",
        load_lookback_days=90,
        persist=False,
    )

    assert summary.calibration.id is None
    assert summary.calibration.threshold_speed_mps == pytest.approx(4.0, rel=0.02)
    assert summary.load.calibration_id is None
    assert summary.load.activities_processed == 1
    # Only the stale snapshot remains; persist=False wrote nothing new
    assert db.query("SELECT COUNT(*) AS n FROM running_calibration_snapshot")[0]["n"] == 1
    stale_row = db.query(
        "SELECT threshold_speed_mps FROM running_calibration_snapshot WHERE id = ?",
        (stale_id,),
    )[0]
    assert stale_row["threshold_speed_mps"] == 2.0
    assert db.fetch_activity_training_load("recent_run") is None


def test_training_load_tables_exist_on_fresh_db(db):
    tables = {row["name"] for row in db.query("SELECT name FROM sqlite_master WHERE type='table'")}

    assert "training_load_calibration" not in tables
    assert "activity_training_load" in tables
    assert "daily_training_load" in tables


def test_training_load_tables_added_to_legacy_db(tmp_path):
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
        CREATE TABLE dashboard (id INTEGER PRIMARY KEY CHECK(id = 1));
        """
    )
    conn.commit()
    conn.close()

    with Database(legacy_path) as db:
        tables = {row["name"] for row in db.query("SELECT name FROM sqlite_master WHERE type='table'")}

    assert "training_load_calibration" not in tables
    assert "activity_training_load" in tables
    assert "daily_training_load" in tables


def test_recompute_persists_activity_and_daily_load_idempotently(db):
    # estimate_rhr_baseline requires min_samples=14; supply 14 days of RHR data.
    # daily_health.date is stored as YYYYMMDD (Shanghai-local) per CLAUDE.md timezone rules.
    for _i in range(14):
        _d = date(2026, 5, 1) - timedelta(days=_i)
        db.upsert_daily_health(
            DailyHealth(_d.strftime("%Y%m%d"), None, None, 50, None, None, None, None, None)
        )
    db.upsert_daily_hrv(DailyHrv("2026-05-01", last_night_avg=60))
    db.upsert_activity_feedback("run1", rpe=5, mood_tags=[], note="ok")
    db.upsert_activity(
        _make_activity(
            "run1",
            "2026-05-01T00:00:00+00:00",
            samples=_timeseries(hr=170, speed_mps=4.0),
        ),
        provider="garmin",
    )

    refresh_training_load_calibration(db, as_of_date="2026-05-01")
    first = recompute_training_load(db, start="2026-05-01", end="2026-05-01")
    second = recompute_training_load(db, start="2026-05-01", end="2026-05-01")

    assert first.activities_processed == 1
    assert second.activities_processed == 1
    assert db.query("SELECT COUNT(*) AS n FROM activity_training_load")[0]["n"] == 1
    assert db.query("SELECT COUNT(*) AS n FROM daily_training_load")[0]["n"] == 1
    activity_row = db.fetch_activity_training_load("run1")
    assert activity_row is not None
    assert activity_row["label_id"] == "run1"
    assert activity_row["training_dose"] is not None
    assert activity_row["excluded_from_pmc"] == 0
    daily_rows = db.fetch_daily_training_load("2026-05-01", "2026-05-01")
    assert len(daily_rows) == 1
    assert json.loads(activity_row["reasons_json"]) == []


def test_recompute_removes_superseded_daily_model_version(db):
    db._conn.execute(
        "INSERT INTO daily_training_load "
        "(date, algorithm_version, training_dose, acute_load, chronic_load) "
        "VALUES ('2026-05-01', 1, 999, 999, 999)"
    )
    db.upsert_activity(
        _make_activity(
            "run1", "2026-05-01T00:00:00+00:00",
            samples=_timeseries(hr=None, speed_mps=4.0),
        )
    )
    calibration = CalibrationSnapshot(
        as_of_date=date(2026, 5, 1), threshold_speed_mps=4.0
    )

    recompute_training_load(
        db, start="2026-05-01", end="2026-05-01",
        calibration_override=calibration,
    )

    rows = db.query(
        "SELECT algorithm_version FROM daily_training_load WHERE date = '2026-05-01'"
    )
    assert [row["algorithm_version"] for row in rows] == [2]


def test_recompute_persist_false_returns_summary_without_writes(db):
    db.upsert_activity(
        _make_activity("run1", "2026-05-01T00:00:00+00:00", samples=_timeseries(hr=None, speed_mps=4.0))
    )

    summary = recompute_training_load(db, start="2026-05-01", end="2026-05-01", persist=False)

    assert summary.activities_processed == 1
    assert db.query("SELECT COUNT(*) AS n FROM activity_training_load")[0]["n"] == 0
    assert db.query("SELECT COUNT(*) AS n FROM daily_training_load")[0]["n"] == 0


def test_recompute_label_filter_limits_processed_activities(db):
    db.upsert_activity(_make_activity("run1", "2026-05-01T00:00:00+00:00", samples=_timeseries()))
    db.upsert_activity(_make_activity("run2", "2026-05-02T00:00:00+00:00", samples=_timeseries()))

    summary = recompute_training_load(db, label_ids=["run2"])

    assert summary.activities_processed == 1
    assert db.fetch_activity_training_load("run1") is None
    assert db.fetch_activity_training_load("run2") is not None


def test_refresh_bounds_calibration_history_to_lookback_window(db, monkeypatch):
    """refresh_training_load_calibration limits history to the lookback window.
    Activities outside the window must not be fetched by the repo."""
    db.upsert_activity(_make_activity("old", "2025-01-01T00:00:00+00:00", samples=_timeseries()))
    db.upsert_activity(_make_activity("recent", "2026-05-01T00:00:00+00:00", samples=_timeseries()))

    fetched_dates: list[str] = []
    original_fetch = None

    def patched_fetch_history(self, start, end):
        fetched_dates.extend(
            a.activity_date.isoformat() for a in original_fetch(self, start, end)
        )
        return original_fetch(self, start, end)

    from stride_storage.sqlite.calibration_connector import SQLiteRunningCalibrationRepository
    original_fetch = SQLiteRunningCalibrationRepository.fetch_history
    monkeypatch.setattr(SQLiteRunningCalibrationRepository, "fetch_history", patched_fetch_history)

    refresh_training_load_calibration(db, as_of_date="2026-05-01", lookback_days=90)

    # "recent" (2026-05-01) is within 90 days of 2026-05-01; "old" (2025-01-01) is not
    assert any("2026" in d for d in fetched_dates), "recent activity must be fetched"
    assert not any("2025" in d for d in fetched_dates), "old activity must not be fetched within 90-day window"


def test_recompute_does_not_normalize_raw_trimp_when_threshold_hr_is_unavailable(db):
    db.upsert_activity(
        _make_activity(
            "hr_only",
            "2026-05-01T00:00:00+00:00",
            avg_hr=160,
            max_hr=170,
            samples=_timeseries(hr=160, speed_mps=None),
        )
    )

    recompute_training_load(db, start="2026-05-01", end="2026-05-01")
    row = db.fetch_activity_training_load("hr_only")

    assert row is not None
    assert row["cardio_load_raw"] is None
    assert row["cardio_tss"] is None
    assert row["training_dose"] is None
    assert row["excluded_from_pmc"] == 1
    assert "hr_calibration_missing" in json.loads(row["reasons_json"])


def test_partial_window_recompute_seeds_atl_ctl_from_prior_day(db):
    """A range-limited recompute must continue the EWMA from the last persisted
    daily_training_load row instead of restarting acute/chronic at zero."""
    db.upsert_daily_health(DailyHealth("2026-05-01", None, None, 50, None, None, None, None, None))
    db.upsert_activity(
        _make_activity(
            "day1",
            "2026-05-01T00:00:00+00:00",
            avg_power=None,
            samples=_timeseries(hr=170, speed_mps=4.0),
        ),
        provider="garmin",
    )
    db.upsert_activity(
        _make_activity(
            "day2",
            "2026-05-02T00:00:00+00:00",
            avg_power=None,
            samples=_timeseries(hr=170, speed_mps=4.0),
        ),
        provider="garmin",
    )

    full = recompute_training_load(db, start="2026-05-01", end="2026-05-02")
    assert full.daily_rows_written == 2
    full_day2 = db.fetch_daily_training_load("2026-05-02", "2026-05-02")[0]

    # Wipe the day-2 row and recompute only day 2. Without prior-state plumbing
    # this would reset acute_load to k_acute*dose ≈ 13.3 instead of carrying
    # over day-1's residual.
    db.query("DELETE FROM daily_training_load WHERE date = '2026-05-02'")

    recompute_training_load(db, start="2026-05-02", end="2026-05-02")
    partial_day2 = db.fetch_daily_training_load("2026-05-02", "2026-05-02")[0]

    # Persisted ATL/CTL are rounded to 4 decimals before seeding prior_state, so
    # accept that round-trip tolerance instead of bit-exact equality.
    # Persisted ATL/CTL are rounded to 4 decimals before seeding prior_state, so
    # accept that round-trip tolerance instead of bit-exact equality.
    assert partial_day2["acute_load"] == pytest.approx(full_day2["acute_load"], abs=1e-3)
    assert partial_day2["chronic_load"] == pytest.approx(full_day2["chronic_load"], abs=1e-3)
    assert partial_day2["form"] == pytest.approx(full_day2["form"], abs=1e-3)


def test_partial_window_recompute_decays_through_rest_day_gap(db):
    """When the prior persisted day is followed by N rest days before the
    recompute window, the EWMA must decay through those zero-dose days before
    applying the new window's dose. Without gap-decay the new window would
    treat the prior load as if it were yesterday's."""
    # Day 1: a training day, then a 4-day rest gap, then day 6.
    db.upsert_activity(
        _make_activity(
            "d1",
            "2026-05-01T00:00:00+00:00",
            avg_power=None,
            samples=_timeseries(hr=170, speed_mps=4.0),
        ),
        provider="garmin",
    )
    db.upsert_activity(
        _make_activity(
            "d6",
            "2026-05-06T00:00:00+00:00",
            avg_power=None,
            samples=_timeseries(hr=170, speed_mps=4.0),
        ),
        provider="garmin",
    )

    # Truth: a full-range recompute walks every day including the 4 zero-dose
    # days, so its day-6 ATL/CTL is the correct target.
    recompute_training_load(db, start="2026-05-01", end="2026-05-06")
    full_day6 = db.fetch_daily_training_load("2026-05-06", "2026-05-06")[0]

    # Wipe May 2–6 and recompute only May 6. Prior state will load from May 1.
    db.query("DELETE FROM daily_training_load WHERE date > '2026-05-01'")
    recompute_training_load(db, start="2026-05-06", end="2026-05-06")
    partial_day6 = db.fetch_daily_training_load("2026-05-06", "2026-05-06")[0]

    assert partial_day6["acute_load"] == pytest.approx(full_day6["acute_load"], abs=1e-3)
    assert partial_day6["chronic_load"] == pytest.approx(full_day6["chronic_load"], abs=1e-3)


def test_partial_window_recompute_backfills_rest_day_gap_rows(db):
    """Sequential post-sync recomputes must leave no holes in the daily series.

    Post-sync calls recompute with start=end=<synced activity's date>. A rest
    day that falls between two sync batches (e.g. a training day, a rest day,
    then another training day synced separately) is never inside any window, so
    its daily_training_load row was never written — the charts then skip that
    day entirely (Dose / ATL-CTL / Form all gap). recompute must extend the
    window back to the last persisted day so the intervening rest days are
    persisted as zero-dose rows.
    """
    db.upsert_activity(
        _make_activity(
            "d1",
            "2026-05-01T00:00:00+00:00",
            avg_power=None,
            samples=_timeseries(hr=170, speed_mps=4.0),
        ),
        provider="garmin",
    )
    db.upsert_activity(
        _make_activity(
            "d3",
            "2026-05-03T00:00:00+00:00",
            avg_power=None,
            samples=_timeseries(hr=170, speed_mps=4.0),
        ),
        provider="garmin",
    )

    # Ground truth: a single contiguous recompute writes all three days.
    recompute_training_load(db, start="2026-05-01", end="2026-05-03")
    full = {r["date"]: dict(r) for r in db.fetch_daily_training_load("2026-05-01", "2026-05-03")}
    assert set(full) == {"2026-05-01", "2026-05-02", "2026-05-03"}

    # Reproduce the post-sync path: wipe, then recompute each batch's own day.
    db.query("DELETE FROM daily_training_load")
    recompute_training_load(db, start="2026-05-01", end="2026-05-01")  # batch 1
    recompute_training_load(db, start="2026-05-03", end="2026-05-03")  # batch 2 (5/2 rested)

    rows = db.fetch_daily_training_load("2026-05-01", "2026-05-03")
    dates = [r["date"] for r in rows]
    assert dates == ["2026-05-01", "2026-05-02", "2026-05-03"], "rest-day 2026-05-02 must be persisted"

    gap_row = {r["date"]: dict(r) for r in rows}["2026-05-02"]
    assert gap_row["training_dose"] == 0
    # The gap row must match what a contiguous recompute produces.
    assert gap_row["acute_load"] == pytest.approx(full["2026-05-02"]["acute_load"], abs=1e-3)
    assert gap_row["chronic_load"] == pytest.approx(full["2026-05-02"]["chronic_load"], abs=1e-3)


def test_fetch_health_rows_handles_compact_yyyymmdd_dates(db):
    """`daily_health.date` is stored as Shanghai-local YYYYMMDD on some
    providers and ISO YYYY-MM-DD on others. Bounded fetches must include
    both — `'20260501' <= '2026-05-02'` is lexicographically false, so an
    SQL `BETWEEN` against ISO bounds would silently drop the compact row."""
    db._conn.execute("INSERT INTO daily_health (date, rhr) VALUES ('20260501', 50)")
    db._conn.execute("INSERT INTO daily_health (date, rhr) VALUES ('2026-05-02', 52)")
    db._conn.commit()

    rows = _fetch_health_rows(db, start=date(2026, 5, 1), end=date(2026, 5, 2))
    by_date = {row.date: row.rhr for row in rows}

    assert by_date[date(2026, 5, 1)] == 50.0
    assert by_date[date(2026, 5, 2)] == 52.0
