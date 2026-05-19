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
        monkeypatch.setattr("stride_core.ability_hook.run_ability_hook", lambda *args, **kwargs: None)

        class FakeClient:
            details_call = None

            def get_activities(self, start: int = 0, limit: int = 25):
                if start > 0:
                    return []
                return [_activity_summary()]

            def get_activity_splits(self, activity_id):
                return {"lapDTOs": []}

            def get_activity_hr_in_timezones(self, activity_id):
                return []

            def get_activity_weather(self, activity_id):
                return {}

            def get_activity_details(self, activity_id, **kwargs):
                self.details_call = kwargs
                return _activity_details()

        client = FakeClient()
        activities, health = run_sync(client, db, full=True, activity_limit=1)

        assert activities == 1
        assert health == 0
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
