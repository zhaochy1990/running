from __future__ import annotations

import json
import sqlite3

from stride_core.db import Database
from stride_core.models import ActivityDetail, DailyHealth, DailyHrv, TimeseriesPoint
from stride_core.training_load.adapter import (
    _fetch_samples,
    _normalize_elapsed_seconds,
    recompute_training_load,
)


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
            distance_m=14.4,
            samples=_timeseries(speed_mps=4.0, distance_scale=100.0),
        ),
        provider="coros",
    )
    db.upsert_activity(
        _make_activity(
            "garmin_run",
            "2026-05-01T00:00:00+00:00",
            sport_type=8001,
            distance_m=14.4,
            samples=_timeseries(speed_mps=4.0),
        ),
        provider="garmin",
    )

    coros_samples = _fetch_samples(db, "coros_run", provider="coros", sport_type=100)
    garmin_samples = _fetch_samples(db, "garmin_run", provider="garmin", sport_type=8001)

    assert coros_samples[-1].distance_m == 14400.0
    assert garmin_samples[-1].distance_m == 14400.0


def test_recompute_normalizes_activity_distance_stored_as_kilometers(db):
    db.upsert_daily_health(DailyHealth("2026-05-01", None, None, 50, None, None, None, None, None))
    db.upsert_activity(
        _make_activity(
            "km_run",
            "2026-05-01T00:00:00+00:00",
            distance_m=14.4,
            avg_power=None,
            samples=_timeseries(hr=170, speed_mps=4.0, distance_scale=100.0),
        ),
        provider="coros",
    )

    recompute_training_load(db, start="2026-05-01", end="2026-05-01")

    calibration = db.query("SELECT * FROM training_load_calibration")[0]
    activity_row = db.fetch_activity_training_load("km_run")
    assert calibration["threshold_speed_mps"] == 4.0
    assert calibration["threshold_hr"] == 170.0
    assert activity_row["external_tss"] == 100.0
    assert activity_row["mechanical_load"] == 14.562


def test_training_load_tables_exist_on_fresh_db(db):
    tables = {row["name"] for row in db.query("SELECT name FROM sqlite_master WHERE type='table'")}

    assert "training_load_calibration" in tables
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

    assert "training_load_calibration" in tables
    assert "activity_training_load" in tables
    assert "daily_training_load" in tables


def test_recompute_persists_activity_and_daily_load_idempotently(db):
    db.upsert_daily_health(DailyHealth("2026-05-01", None, None, 50, None, None, None, None, None))
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
    assert row["cardio_load_raw"] is not None
    assert row["cardio_tss"] is None
    assert row["training_dose"] is None
    assert row["excluded_from_pmc"] == 1
