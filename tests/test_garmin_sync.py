"""Tests for Garmin sync orchestration."""

from __future__ import annotations

from garmin_sync.sync import run_sync


def _activity_summary() -> dict:
    return {
        "activityId": 12345,
        "activityName": "Test Garmin Run",
        "startTimeGMT": "2026-05-16 21:58:52",
        "activityType": {"typeKey": "running", "typeId": 1},
        "distance": 4000.0,
        "duration": 1000.0,
        "averageSpeed": 4.0,
        "averageHR": 150,
        "maxHR": 170,
        "avgPower": 300,
        "maxPower": 450,
        "trainingEffectLabel": "AEROBIC_BASE",
        "activityTrainingLoad": 80.0,
    }


def _activity_details() -> dict:
    return {
        "metricDescriptors": [
            {"key": "directSpeed", "metricsIndex": 0},
            {"key": "sumDistance", "metricsIndex": 1},
            {"key": "sumElapsedDuration", "metricsIndex": 2},
            {"key": "directHeartRate", "metricsIndex": 3},
            {"key": "directPower", "metricsIndex": 4},
        ],
        "activityDetailMetrics": [
            {"metrics": [0.0, 0.0, 0.0, 140, 0]},
            {"metrics": [4.0, 4.0, 1.0, 142, 300]},
        ],
    }


class TestGarminSyncTimeseries:
    def test_sync_writes_activity_detail_metrics_to_unified_timeseries_table(self, db, monkeypatch):
        monkeypatch.setattr("garmin_sync.sync._sync_health", lambda *args, **kwargs: 0)

        class FakeClient:
            details_call = None

            def get_activities(self, start: int = 0, limit: int = 25):
                if start > 0:
                    return []
                return [_activity_summary()]

            def get_activity_splits(self, activity_id):
                return {"lapDTOs": []}

            def get_activity_weather(self, activity_id):
                return {}

            def get_activity_details(self, activity_id, **kwargs):
                self.details_call = kwargs
                return _activity_details()

        client = FakeClient()
        activities, health, activity_label_ids = run_sync(client, db, full=True, activity_limit=1)

        assert activities == 1
        assert health == 0
        assert activity_label_ids == ("12345",)
        assert client.details_call == {"maxchart": 20000, "maxpoly": 20000}
        rows = db.query(
            "SELECT timestamp, distance, heart_rate, speed, power "
            "FROM timeseries WHERE label_id = '12345' ORDER BY rowid"
        )
        assert len(rows) == 2
        assert dict(rows[0]) == {
            "timestamp": 0,
            "distance": 0.0,
            "heart_rate": 140,
            "speed": None,
            "power": None,
        }
        assert dict(rows[1]) == {
            "timestamp": 100,
            "distance": 4.0,
            "heart_rate": 142,
            "speed": 250.0,
            "power": 300,
        }


class TestGarminSyncHealthDates:
    """Verify that _sync_health emits changed dates for HRV-only days and uses
    changed-only detection to avoid spurious recomputes on repeat syncs."""

    def _make_client(
        self,
        *,
        rhr: int | None = None,
        hrv_avg: int | None = None,
        hrv_weekly: int | None = None,
        hrv_status: str | None = None,
        sleep_score: int | None = None,
    ):
        """Build a fake Garmin client returning a single day of data."""
        from garmin_sync.sync import _sync_health  # noqa: F401 - ensure import works

        class FakeClient:
            def get_training_status(self, date_iso):
                return {}

            def get_user_summary(self, date_iso):
                return {"restingHeartRate": rhr}

            def get_sleep_data(self, date_iso):
                if sleep_score is None:
                    return {}
                return {"dailySleepDTO": {"sleepScores": {"overall": {"value": sleep_score}}}}

            def get_hrv_data(self, date_iso):
                if hrv_avg is None and hrv_weekly is None and hrv_status is None:
                    return {}
                return {
                    "hrvSummary": {
                        "lastNightAvg": hrv_avg,
                        "weeklyAvg": hrv_weekly,
                        "status": hrv_status,
                    }
                }

            def get_lactate_threshold(self):
                return {}

            def get_race_predictions(self):
                return []

        return FakeClient()

    def test_hrv_only_day_adds_date_to_health_dates_out(self, db):
        """A day where only HRV was written (no usable health signal) must
        still emit its date so training-load recompute fires for rest days."""
        from garmin_sync.sync import _sync_health

        client = self._make_client(hrv_avg=42, hrv_weekly=44)
        changed: set[str] = set()
        _sync_health(client, db, progress=None, days=1, health_dates_out=changed)

        assert len(changed) == 1

    def test_health_and_hrv_day_adds_date_once(self, db):
        """A day with both health and HRV signals emits the date (deduplicated)."""
        from garmin_sync.sync import _sync_health

        client = self._make_client(rhr=50, hrv_avg=42)
        changed: set[str] = set()
        _sync_health(client, db, progress=None, days=1, health_dates_out=changed)

        assert len(changed) == 1

    def test_repeat_sync_identical_payload_emits_no_dates(self, db):
        """Second sync with same data must not emit any changed dates."""
        from garmin_sync.sync import _sync_health

        client = self._make_client(rhr=50, hrv_avg=42)
        # First sync — populates DB.
        _sync_health(client, db, progress=None, days=1, health_dates_out=set())
        # Second sync — same data, nothing changed.
        changed2: set[str] = set()
        _sync_health(client, db, progress=None, days=1, health_dates_out=changed2)

        assert changed2 == set()

    def test_updated_value_emits_date(self, db):
        """When a key field changes on the second sync, the date is emitted."""
        from garmin_sync.sync import _sync_health

        client_first = self._make_client(rhr=50, hrv_avg=42)
        _sync_health(client_first, db, progress=None, days=1, health_dates_out=set())

        client_updated = self._make_client(rhr=48, hrv_avg=42)  # rhr dropped
        changed2: set[str] = set()
        _sync_health(client_updated, db, progress=None, days=1, health_dates_out=changed2)

        assert len(changed2) == 1

    def test_status_only_update_emits_date(self, db):
        from garmin_sync.sync import _sync_health

        _sync_health(
            self._make_client(hrv_avg=42, hrv_weekly=44, hrv_status="BALANCED"),
            db,
            progress=None,
            days=1,
            health_dates_out=set(),
        )
        changed: set[str] = set()
        _sync_health(
            self._make_client(hrv_avg=42, hrv_weekly=44, hrv_status="LOW"),
            db,
            progress=None,
            days=1,
            health_dates_out=changed,
        )

        assert len(changed) == 1

    def test_sleep_score_only_update_emits_date(self, db):
        from garmin_sync.sync import _sync_health

        _sync_health(
            self._make_client(sleep_score=80),
            db,
            progress=None,
            days=1,
            health_dates_out=set(),
        )
        changed: set[str] = set()
        _sync_health(
            self._make_client(sleep_score=55),
            db,
            progress=None,
            days=1,
            health_dates_out=changed,
        )

        assert len(changed) == 1
