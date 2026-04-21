"""Tests for SQLite database layer."""

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
