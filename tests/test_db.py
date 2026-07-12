"""Tests for SQLite database layer."""

import json
from datetime import timedelta

import pytest

from stride_core.models import (
    ActivityDetail, DailyHealth, Dashboard, Lap, TimeseriesPoint, Zone,
)
from stride_core.timefmt import today_shanghai
from stride_storage.sqlite.database import Database


def _make_detail(label_id="test1", sport_type=100, date="20260315", distance=10000):
    return ActivityDetail(
        label_id=label_id, name="Test Run", sport_type=sport_type,
        sport_name="Run", date=date, distance_m=distance, duration_s=3000,
        avg_pace_s_km=300, adjusted_pace=None, best_km_pace=None, max_pace=None,
        avg_hr=145, max_hr=170, avg_cadence=180, max_cadence=190,
        avg_power=None, max_power=None, avg_step_len_cm=None,
        ascent_m=100, descent_m=90, calories_kcal=500,
        aerobic_effect=3.5, anaerobic_effect=1.2,
        training_load=85, vo2max=52.0, performance=None, train_type="Aerobic Endurance",
        temperature=18.0, humidity=45.0, feels_like=16.0, wind_speed=12.0,
        laps=[
            Lap(1, "autoKm", 1000, 300, 300, None, 145, 155, 180, None, 10, 8),
        ],
        zones=[
            Zone("heartRate", 1, 100, 120, "bpm", 600, 20),
            Zone("heartRate", 2, 120, 140, "bpm", 1200, 40),
        ],
        timeseries=[],
    )


class TestDatabaseActivities:
    def test_default_sqlite_journal_mode_is_wal(self, tmp_path, monkeypatch):
        monkeypatch.delenv("STRIDE_SQLITE_JOURNAL_MODE", raising=False)
        monkeypatch.delenv("STRIDE_CONFIG_ENV", raising=False)
        monkeypatch.delenv("STRIDE_ENV", raising=False)

        with Database(tmp_path / "journal-default.db") as db:
            mode = db._conn.execute("PRAGMA journal_mode").fetchone()[0]

        assert mode.lower() == "wal"

    def test_prod_sqlite_journal_mode_avoids_wal(self, tmp_path, monkeypatch):
        monkeypatch.delenv("STRIDE_SQLITE_JOURNAL_MODE", raising=False)
        monkeypatch.setenv("STRIDE_CONFIG_ENV", "prod")

        with Database(tmp_path / "journal-prod.db") as db:
            mode = db._conn.execute("PRAGMA journal_mode").fetchone()[0]

        assert mode.lower() == "delete"

    def test_upsert_and_exists(self, db):
        detail = _make_detail()
        assert not db.activity_exists("test1")
        db.upsert_activity(detail)
        assert db.activity_exists("test1")

    def test_upsert_idempotent(self, db):
        detail = _make_detail()
        db.upsert_activity(detail)
        db.upsert_activity(detail)  # Should not fail
        assert db.get_activity_count() == 1

    def test_activity_count(self, db):
        assert db.get_activity_count() == 0
        db.upsert_activity(_make_detail("a1"))
        db.upsert_activity(_make_detail("a2"))
        assert db.get_activity_count() == 2

    def test_total_distance(self, db):
        db.upsert_activity(_make_detail("a1", distance=10000))
        db.upsert_activity(_make_detail("a2", distance=5000))
        assert db.get_total_distance_km() == 15.0

    def test_latest_activity_date(self, db):
        db.upsert_activity(_make_detail("a1", date="20260310"))
        db.upsert_activity(_make_detail("a2", date="20260315"))
        assert db.get_latest_activity_date() == "20260315"

    def test_running_week_summaries_weight_actual_metrics_by_duration(self, db):
        db.upsert_activity(_make_detail(
            "run1",
            date="2026-05-04T00:00:00+00:00",
            distance=10_000.0,
        ))
        db.upsert_activity(_make_detail(
            "run2",
            date="2026-05-05T00:00:00+00:00",
            distance=5_000.0,
        ))
        db.upsert_activity(_make_detail(
            "bike",
            sport_type=200,
            date="2026-05-05T00:00:00+00:00",
            distance=80_000.0,
        ))
        db._conn.execute(
            "UPDATE activities SET duration_s = 6000, avg_pace_s_km = 360, avg_hr = 150 WHERE label_id = 'run1'"
        )
        db._conn.execute(
            "UPDATE activities SET duration_s = 1500, avg_pace_s_km = 300, avg_hr = 130 WHERE label_id = 'run2'"
        )
        db._conn.execute(
            "UPDATE activities SET sport_name = 'Bike' WHERE label_id = 'bike'"
        )
        db._conn.commit()

        summaries = db.get_running_week_summaries([(1, "2026-05-04", "2026-05-10")])

        assert summaries[1] == {
            "run_count": 2,
            "actual_distance_km": 15.0,
            "total_duration_s": 7500,
            "avg_pace_s_km": 348,
            "avg_hr": 146,
        }

    def test_laps_stored(self, db):
        db.upsert_activity(_make_detail())
        rows = db.query("SELECT * FROM laps WHERE label_id = 'test1'")
        assert len(rows) == 1
        assert dict(rows[0])["lap_index"] == 1

    def test_zones_stored(self, db):
        db.upsert_activity(_make_detail())
        rows = db.query("SELECT * FROM zones WHERE label_id = 'test1'")
        assert len(rows) == 2

    def test_timeseries_running_form_roundtrip(self, db):
        # Two points: one fully populated with running-form channels (mid-run),
        # one sparse (start-of-run, only GPS+timestamp). Both must persist
        # cleanly with NULLs preserved on the sparse one.
        full = TimeseriesPoint(
            timestamp=177823754500, distance=3213.0, heart_rate=145, speed=319,
            adjusted_pace=319.0, cadence=178, altitude=4.0, power=236,
            ground_contact_time_ms=240, vertical_oscillation_mm=85,
            vertical_ratio_pct=8.0, cadence_length_cm=106,
            slope=0, heart_level=3,
        )
        sparse = TimeseriesPoint(
            timestamp=177823654500, distance=0, heart_rate=None, speed=None,
            adjusted_pace=None, cadence=None, altitude=None, power=None,
        )
        detail = _make_detail()
        detail.timeseries = [full, sparse]
        db.upsert_activity(detail)

        rows = db.query(
            "SELECT ground_contact_time_ms, vertical_oscillation_mm, "
            "vertical_ratio_pct, cadence_length_cm, slope, heart_level "
            "FROM timeseries WHERE label_id = 'test1' ORDER BY id"
        )
        assert len(rows) == 2
        r0 = dict(rows[0])
        assert r0["ground_contact_time_ms"] == 240
        assert r0["vertical_oscillation_mm"] == 85
        assert r0["vertical_ratio_pct"] == 8.0
        assert r0["cadence_length_cm"] == 106
        assert r0["slope"] == 0
        assert r0["heart_level"] == 3
        r1 = dict(rows[1])
        assert all(
            r1[k] is None for k in (
                "ground_contact_time_ms", "vertical_oscillation_mm",
                "vertical_ratio_pct", "cadence_length_cm", "slope", "heart_level",
            )
        )


class TestDatabaseHealth:
    def test_upsert_daily_health(self, db):
        h = DailyHealth("20260315", 45.5, 38.2, 52, 10000, 3000, 1.2, "Optimal", 30)
        db.upsert_daily_health(h)
        rows = db.query("SELECT * FROM daily_health WHERE date = '20260315'")
        assert len(rows) == 1
        assert dict(rows[0])["rhr"] == 52

    def test_upsert_dashboard(self, db):
        d = Dashboard(
            running_level=65, aerobic_score=70, lactate_threshold_score=55,
            anaerobic_endurance_score=40, anaerobic_capacity_score=35,
            rhr=52, threshold_hr=165, threshold_pace_s_km=280,
            recovery_pct=85, avg_sleep_hrv=55, hrv_normal_low=40, hrv_normal_high=70,
            weekly_distance_m=50000, weekly_duration_s=18000,
            race_predictions=[],
        )
        db.upsert_dashboard(d)
        rows = db.query("SELECT * FROM dashboard")
        assert len(rows) == 1
        assert dict(rows[0])["running_level"] == 65


class TestSyncMeta:
    def test_get_set(self, db):
        assert db.get_meta("last_sync") is None
        db.set_meta("last_sync", "2026-03-15T10:00:00")
        assert db.get_meta("last_sync") == "2026-03-15T10:00:00"

    def test_overwrite(self, db):
        db.set_meta("key", "v1")
        db.set_meta("key", "v2")
        assert db.get_meta("key") == "v2"


class TestWeeklyPlan:
    def test_weekly_plan_roundtrip(self, db):
        db.upsert_weekly_plan("2026-04-20_04-26(W0)", "# Plan v1", generated_by="gpt-5.5")
        row = db.get_weekly_plan_row("2026-04-20_04-26(W0)")
        assert row is not None
        d = dict(row)
        assert d["content_md"] == "# Plan v1"
        assert d["generated_by"] == "gpt-5.5"
        assert d["generated_at"] is not None

    def test_weekly_plan_upsert_overwrites(self, db):
        week = "2026-04-20_04-26(W0)"
        db.upsert_weekly_plan(week, "draft 1", generated_by="gpt-5.5")
        db.upsert_weekly_plan(week, "draft 2", generated_by="claude-opus-4.6")
        row = db.get_weekly_plan_row(week)
        assert dict(row)["content_md"] == "draft 2"
        assert dict(row)["generated_by"] == "claude-opus-4.6"


class TestAbility:
    def test_ability_snapshot_roundtrip(self, db):
        # Use a date inside the 30-day fetch window relative to today so this
        # test stays valid as time passes (originally hardcoded 2026-04-23,
        # which silently fell out of the window once "today" advanced past it).
        snap_date = (today_shanghai() - timedelta(days=5)).isoformat()
        db.upsert_ability_snapshot(
            date=snap_date, level="L4", dimension="composite",
            value=67.5, evidence_activity_ids=["lbl_a", "lbl_b"],
        )
        db.upsert_ability_snapshot(
            date=snap_date, level="L3", dimension="vo2max",
            value=58.2, evidence_activity_ids=["lbl_a"],
        )
        # Idempotent upsert — same key updates value
        db.upsert_ability_snapshot(
            date=snap_date, level="L4", dimension="composite",
            value=68.0, evidence_activity_ids=["lbl_a", "lbl_b", "lbl_c"],
        )
        rows = db.fetch_ability_history(days=30)
        by_key = {(r["level"], r["dimension"]): r for r in rows}
        assert len(rows) == 2
        composite = by_key[("L4", "composite")]
        assert composite["value"] == 68.0
        assert json.loads(composite["evidence_activity_ids"]) == ["lbl_a", "lbl_b", "lbl_c"]
        vo2 = by_key[("L3", "vo2max")]
        assert vo2["value"] == 58.2
        assert json.loads(vo2["evidence_activity_ids"]) == ["lbl_a"]

    def test_activity_ability_roundtrip(self, db):
        # Parent activity row must exist (FK to activities.label_id)
        db.upsert_activity(_make_detail(label_id="a_quality"))
        breakdown = {
            "pace_adherence": 82.0, "hr_zone": 75.5, "pace_stability": 90.0,
            "hr_decoupling": 88.0, "cadence_stability": 92.0,
        }
        contribution = {
            "aerobic": 0.12, "lt": 0.0, "vo2max": 0.0,
            "endurance": 0.0, "economy": 0.05, "recovery": 0.0,
        }
        db.upsert_activity_ability(
            label_id="a_quality", l1_quality=84.3,
            l1_breakdown=breakdown, contribution=contribution,
        )
        row = db.fetch_activity_ability("a_quality")
        assert row is not None
        assert row["l1_quality"] == 84.3
        assert json.loads(row["l1_breakdown"]) == breakdown
        assert json.loads(row["contribution"]) == contribution
        # Idempotent upsert
        db.upsert_activity_ability(
            label_id="a_quality", l1_quality=90.0,
            l1_breakdown=breakdown, contribution=contribution,
        )
        row2 = db.fetch_activity_ability("a_quality")
        assert row2["l1_quality"] == 90.0
        # Missing label_id returns None
        assert db.fetch_activity_ability("nonexistent") is None


class TestActivitiesIndexes:
    """Verify SQLite picks up the two activity-date indexes."""

    @pytest.fixture
    def seeded_db(self, db):
        """64 activities + ANALYZE so the planner has stats to prefer the
        index over a scan. SQLite may default to a sequential scan on a
        small unANALYZE'd table even when the right index exists; dropping
        either the row count or ANALYZE here will silently regress these
        tests on some SQLite builds."""
        for i in range(64):
            db.upsert_activity(_make_detail(
                label_id=f"a{i}",
                date=f"2026-05-{(i % 28) + 1:02d}T10:00:00+00:00",
            ))
        db.query("ANALYZE")
        return db

    @staticmethod
    def _plan(db, sql, params=()):
        # sqlite3.Row.__str__ doesn't expose columns; pull the `detail`
        # column where the EXPLAIN narrative lives.
        return " | ".join(
            row["detail"]
            for row in db.query(f"EXPLAIN QUERY PLAN {sql}", params)
        )

    def test_shanghai_day_index_used_for_common_query_shapes(self, seeded_db):
        from stride_core.timefmt import SHANGHAI_DAY_SQL

        for sql, params in [
            (f"SELECT label_id FROM activities WHERE {SHANGHAI_DAY_SQL} >= ?", ("2026-05-09",)),
            (f"SELECT label_id FROM activities WHERE {SHANGHAI_DAY_SQL} BETWEEN ? AND ?", ("2026-05-04", "2026-05-10")),
            (f"SELECT label_id FROM activities WHERE {SHANGHAI_DAY_SQL} = ?", ("2026-05-09",)),
        ]:
            joined = self._plan(seeded_db, sql, params)
            assert "idx_activities_shanghai_day" in joined, (
                f"functional index not used for: {sql}\nplan: {joined}"
            )

    def test_plain_date_index_used_for_ordering_and_max_probes(self, seeded_db):
        for sql, params in [
            ("SELECT label_id, date FROM activities ORDER BY date DESC LIMIT 5", ()),
            ("SELECT MAX(date) FROM activities", ()),
            ("SELECT label_id FROM activities WHERE date >= ?", ("2026-05-09T00:00:00+00:00",)),
        ]:
            joined = self._plan(seeded_db, sql, params)
            assert "idx_activities_date" in joined, (
                f"plain date index not used for: {sql}\nplan: {joined}"
            )
