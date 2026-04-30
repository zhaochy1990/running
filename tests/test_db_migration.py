"""Tests for the multi-provider DB migration (v1)."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from stride_core.db import Database
from stride_core.models import ActivityDetail, DailyHealth, Dashboard


# ─────────────────────────────────────────────────────────────────────────────
# Provider column on fresh DB
# ─────────────────────────────────────────────────────────────────────────────


def _activity_columns(db: Database) -> set[str]:
    return {row[1] for row in db._conn.execute("PRAGMA table_info(activities)").fetchall()}


def _daily_health_columns(db: Database) -> set[str]:
    return {row[1] for row in db._conn.execute("PRAGMA table_info(daily_health)").fetchall()}


def _dashboard_columns(db: Database) -> set[str]:
    return {row[1] for row in db._conn.execute("PRAGMA table_info(dashboard)").fetchall()}


def _scheduled_workout_columns(db: Database) -> set[str]:
    return {row[1] for row in db._conn.execute("PRAGMA table_info(scheduled_workout)").fetchall()}


class TestProviderColumns:
    def test_activities_has_provider(self, db):
        assert "provider" in _activity_columns(db)

    def test_daily_health_has_provider(self, db):
        assert "provider" in _daily_health_columns(db)

    def test_dashboard_has_provider(self, db):
        assert "provider" in _dashboard_columns(db)

    def test_provider_defaults_to_coros_on_upsert(self, db):
        from tests.test_db import _make_detail

        db.upsert_activity(_make_detail("a1"))
        row = db.query("SELECT provider FROM activities WHERE label_id = 'a1'")[0]
        assert row["provider"] == "coros"

    def test_provider_can_be_overridden(self, db):
        from tests.test_db import _make_detail

        db.upsert_activity(_make_detail("garmin1"), provider="garmin")
        row = db.query("SELECT provider FROM activities WHERE label_id = 'garmin1'")[0]
        assert row["provider"] == "garmin"

    def test_daily_health_provider_default(self, db):
        h = DailyHealth("2026-04-30", 50.0, 45.0, 48, 0, 0, 1.1, "Optimal", 30)
        db.upsert_daily_health(h)
        row = db.query("SELECT provider FROM daily_health WHERE date = '2026-04-30'")[0]
        assert row["provider"] == "coros"

    def test_daily_health_provider_override(self, db):
        h = DailyHealth("2026-04-29", 50.0, 45.0, 48, 0, 0, 1.1, "Optimal", 30)
        db.upsert_daily_health(h, provider="garmin")
        row = db.query("SELECT provider FROM daily_health WHERE date = '2026-04-29'")[0]
        assert row["provider"] == "garmin"

    def test_dashboard_provider_override(self, db):
        d = Dashboard(
            running_level=70, aerobic_score=None, lactate_threshold_score=None,
            anaerobic_endurance_score=None, anaerobic_capacity_score=None,
            rhr=48, threshold_hr=170, threshold_pace_s_km=240,
            recovery_pct=None, avg_sleep_hrv=55, hrv_normal_low=40, hrv_normal_high=70,
            weekly_distance_m=50000, weekly_duration_s=18000,
            race_predictions=[],
        )
        db.upsert_dashboard(d, provider="garmin")
        row = db.query("SELECT provider FROM dashboard")[0]
        assert row["provider"] == "garmin"


# ─────────────────────────────────────────────────────────────────────────────
# Idempotent ALTER on a legacy DB
# ─────────────────────────────────────────────────────────────────────────────


_LEGACY_SCHEMA = """
CREATE TABLE activities (
    label_id        TEXT PRIMARY KEY,
    name            TEXT,
    sport_type      INTEGER NOT NULL,
    sport_name      TEXT,
    date            TEXT NOT NULL,
    distance_m      REAL,
    duration_s      REAL
);
CREATE TABLE daily_health (
    date    TEXT PRIMARY KEY,
    rhr     INTEGER
);
CREATE TABLE dashboard (
    id              INTEGER PRIMARY KEY CHECK(id = 1),
    running_level   REAL,
    updated_at      TEXT
);
"""


class TestLegacyMigration:
    def test_provider_columns_added_to_legacy_db(self, tmp_path: Path):
        """A pre-v1 DB (no provider columns) gets them added by _migrate."""
        legacy_path = tmp_path / "legacy.db"
        # Hand-craft a pre-v1 DB with the old shape.
        conn = sqlite3.connect(str(legacy_path))
        conn.executescript(_LEGACY_SCHEMA)
        # Insert a legacy row with no provider info (mimics pre-migration data).
        conn.execute(
            "INSERT INTO activities (label_id, name, sport_type, date, distance_m, duration_s) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("legacy_a1", "Old Run", 100, "2026-01-01", 5000.0, 1500.0),
        )
        conn.execute("INSERT INTO daily_health (date, rhr) VALUES (?, ?)", ("2026-01-01", 55))
        conn.execute("INSERT INTO dashboard (id, running_level) VALUES (1, 60)")
        conn.commit()
        conn.close()

        # Open via Database — _migrate should add the missing columns.
        db = Database(db_path=legacy_path)
        try:
            assert "provider" in _activity_columns(db)
            assert "provider" in _daily_health_columns(db)
            assert "provider" in _dashboard_columns(db)

            # Existing rows now carry the default 'coros' tag.
            assert db.query("SELECT provider FROM activities")[0]["provider"] == "coros"
            assert db.query("SELECT provider FROM daily_health")[0]["provider"] == "coros"
            assert db.query("SELECT provider FROM dashboard")[0]["provider"] == "coros"
        finally:
            db.close()

    def test_migration_is_idempotent(self, tmp_path: Path):
        """Re-running _migrate doesn't fail with 'duplicate column'."""
        legacy_path = tmp_path / "legacy.db"
        conn = sqlite3.connect(str(legacy_path))
        conn.executescript(_LEGACY_SCHEMA)
        conn.commit()
        conn.close()

        db = Database(db_path=legacy_path)
        try:
            # Already migrated once via __init__; migrate again should be a no-op.
            db._migrate()
            db._migrate()
        finally:
            db.close()


# ─────────────────────────────────────────────────────────────────────────────
# scheduled_workout table CRUD
# ─────────────────────────────────────────────────────────────────────────────


class TestScheduledWorkoutTable:
    def test_table_exists_with_expected_columns(self, db):
        cols = _scheduled_workout_columns(db)
        expected = {
            "id", "date", "kind", "name", "spec_json", "status",
            "provider", "provider_workout_id", "pushed_at",
            "completed_label_id", "note", "created_at", "updated_at",
        }
        assert expected.issubset(cols), f"missing: {expected - cols}"

    def test_create_returns_id(self, db):
        wid = db.create_scheduled_workout(
            date="2026-05-01", kind="run", name="[STRIDE] Easy 10K",
            spec_json='{"schema": "run-workout/v1"}',
        )
        assert isinstance(wid, int) and wid > 0

    def test_create_default_status_is_draft(self, db):
        wid = db.create_scheduled_workout(
            date="2026-05-01", kind="run", name="x", spec_json="{}",
        )
        row = db.get_scheduled_workout(wid)
        assert row["status"] == "draft"
        assert row["provider"] is None  # not pushed yet
        assert row["provider_workout_id"] is None

    def test_get_returns_none_for_missing(self, db):
        assert db.get_scheduled_workout(99999) is None

    def test_list_filters(self, db):
        db.create_scheduled_workout(
            date="2026-05-01", kind="run", name="Easy", spec_json="{}",
        )
        db.create_scheduled_workout(
            date="2026-05-02", kind="strength", name="Core", spec_json="{}",
        )
        db.create_scheduled_workout(
            date="2026-05-03", kind="run", name="Long", spec_json="{}", status="pushed",
        )

        all_rows = db.list_scheduled_workouts()
        assert len(all_rows) == 3

        runs = db.list_scheduled_workouts(kind="run")
        assert len(runs) == 2
        assert all(r["kind"] == "run" for r in runs)

        drafts = db.list_scheduled_workouts(status="draft")
        assert len(drafts) == 2

        in_range = db.list_scheduled_workouts(start="2026-05-02", end="2026-05-02")
        assert len(in_range) == 1
        assert in_range[0]["kind"] == "strength"

    def test_update_spec(self, db):
        wid = db.create_scheduled_workout(
            date="2026-05-01", kind="run", name="Easy", spec_json='{"v": 1}',
        )
        db.update_scheduled_workout_spec(wid, spec_json='{"v": 2}', name="Easy v2")
        row = db.get_scheduled_workout(wid)
        assert row["spec_json"] == '{"v": 2}'
        assert row["name"] == "Easy v2"

    def test_update_with_no_fields_is_noop(self, db):
        wid = db.create_scheduled_workout(
            date="2026-05-01", kind="run", name="x", spec_json="{}",
        )
        db.update_scheduled_workout_spec(wid)  # no fields
        row = db.get_scheduled_workout(wid)
        assert row["name"] == "x"

    def test_mark_pushed_stamps_provider(self, db):
        wid = db.create_scheduled_workout(
            date="2026-05-01", kind="run", name="x", spec_json="{}",
        )
        db.mark_scheduled_workout_pushed(
            wid, provider="garmin", provider_workout_id="35977804",
        )
        row = db.get_scheduled_workout(wid)
        assert row["status"] == "pushed"
        assert row["provider"] == "garmin"
        assert row["provider_workout_id"] == "35977804"
        assert row["pushed_at"] is not None

    def test_mark_completed_links_activity(self, db):
        from tests.test_db import _make_detail

        # Create the activity first so the FK is satisfiable.
        db.upsert_activity(_make_detail("activity_x"))
        wid = db.create_scheduled_workout(
            date="2026-05-01", kind="run", name="x", spec_json="{}",
        )
        db.mark_scheduled_workout_completed(wid, label_id="activity_x")
        row = db.get_scheduled_workout(wid)
        assert row["status"] == "completed"
        assert row["completed_label_id"] == "activity_x"

    def test_mark_skipped(self, db):
        wid = db.create_scheduled_workout(
            date="2026-05-01", kind="run", name="x", spec_json="{}",
        )
        db.mark_scheduled_workout_skipped(wid)
        row = db.get_scheduled_workout(wid)
        assert row["status"] == "skipped"

    def test_delete_returns_true_when_present(self, db):
        wid = db.create_scheduled_workout(
            date="2026-05-01", kind="run", name="x", spec_json="{}",
        )
        assert db.delete_scheduled_workout(wid) is True
        assert db.get_scheduled_workout(wid) is None

    def test_delete_returns_false_when_missing(self, db):
        assert db.delete_scheduled_workout(99999) is False

    def test_indexes_exist(self, db):
        idx = {row[1] for row in db._conn.execute(
            "SELECT * FROM sqlite_master WHERE type='index' AND tbl_name='scheduled_workout'"
        ).fetchall()}
        assert "idx_scheduled_workout_date" in idx
        assert "idx_scheduled_workout_status" in idx


# ─────────────────────────────────────────────────────────────────────────────
# End-to-end: store a real NormalizedRunWorkout JSON
# ─────────────────────────────────────────────────────────────────────────────


def test_roundtrip_with_normalized_run_workout(db):
    """The spec_json column actually round-trips a NormalizedRunWorkout."""
    from stride_core.workout_spec import (
        Duration, NormalizedRunWorkout, StepKind, Target, WorkoutBlock, WorkoutStep,
        parse_pace_s_km,
    )

    workout = NormalizedRunWorkout(
        name="6x800m",
        date="2026-05-01",
        blocks=(
            WorkoutBlock(steps=(
                WorkoutStep(StepKind.WARMUP, Duration.of_time_min(10)),
            )),
            WorkoutBlock(repeat=6, steps=(
                WorkoutStep(
                    StepKind.WORK,
                    Duration.of_distance_m(800),
                    Target.pace_range_s_km(parse_pace_s_km("3:30"), parse_pace_s_km("3:20")),
                ),
                WorkoutStep(StepKind.RECOVERY, Duration.of_time_s(60)),
            )),
            WorkoutBlock(steps=(
                WorkoutStep(StepKind.COOLDOWN, Duration.of_time_min(5)),
            )),
        ),
    )
    spec_json = json.dumps(workout.to_dict(), ensure_ascii=False)

    wid = db.create_scheduled_workout(
        date=workout.date, kind="run", name=workout.name, spec_json=spec_json,
    )
    row = db.get_scheduled_workout(wid)
    restored = NormalizedRunWorkout.from_dict(json.loads(row["spec_json"]))
    assert restored == workout
