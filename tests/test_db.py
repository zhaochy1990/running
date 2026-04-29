"""Tests for SQLite database layer."""

import json

from stride_core.models import ActivityDetail, DailyHealth, Dashboard, Lap, Zone


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

    def test_laps_stored(self, db):
        db.upsert_activity(_make_detail())
        rows = db.query("SELECT * FROM laps WHERE label_id = 'test1'")
        assert len(rows) == 1
        assert dict(rows[0])["lap_index"] == 1

    def test_zones_stored(self, db):
        db.upsert_activity(_make_detail())
        rows = db.query("SELECT * FROM zones WHERE label_id = 'test1'")
        assert len(rows) == 2


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
        db.upsert_ability_snapshot(
            date="2026-04-23", level="L4", dimension="composite",
            value=67.5, evidence_activity_ids=["lbl_a", "lbl_b"],
        )
        db.upsert_ability_snapshot(
            date="2026-04-23", level="L3", dimension="vo2max",
            value=58.2, evidence_activity_ids=["lbl_a"],
        )
        # Idempotent upsert — same key updates value
        db.upsert_ability_snapshot(
            date="2026-04-23", level="L4", dimension="composite",
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
