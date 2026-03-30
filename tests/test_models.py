"""Tests for unit conversions in models.py."""

from coros_sync.models import (
    Activity, ActivityDetail, DailyHealth, Dashboard, Lap, RacePrediction, Zone,
    TimeseriesPoint, pace_str, sport_name, train_type_name,
)


def test_pace_str():
    assert pace_str(300) == "5:00/km"
    assert pace_str(265) == "4:25/km"
    assert pace_str(0) is None
    assert pace_str(None) is None


def test_sport_name():
    assert sport_name(100) == "Run"
    assert sport_name(102) == "Trail Run"
    assert sport_name(9999) == "Unknown (9999)"


def test_train_type_name():
    assert train_type_name(1) == "Base"
    assert train_type_name(5) == "VO2 Max"


class TestActivityFromApi:
    def test_basic_conversion(self):
        data = {
            "labelId": "abc123",
            "name": "Morning Run",
            "sportType": 100,
            "date": "20260315",
            "distance": 10000,  # meters
            "totalTime": 3000,  # seconds
            "avgSpeed": 300,    # 5:00/km
            "avgHr": 145,
            "ascent": 120,
            "calorie": 500000,  # cal * 1000
            "trainingLoad": 85,
            "device": "PACE 4",
        }
        a = Activity.from_api(data)
        assert a.label_id == "abc123"
        assert a.distance_m == 10000
        assert a.duration_s == 3000
        assert a.calories_kcal == 500
        assert a.sport_name == "Run"

    def test_missing_optional_fields(self):
        data = {"labelId": "xyz", "sportType": 100, "date": "20260101"}
        a = Activity.from_api(data)
        assert a.avg_hr is None
        assert a.calories_kcal is None


class TestActivityDetailFromApi:
    def test_detail_unit_conversion(self):
        data = {
            "data": {
                "summary": {
                    "name": "Long Run",
                    "sportType": 100,
                    "startTimestamp": 170000000000,  # centiseconds-ish
                    "distance": 2100000000,  # cm * 1000 = 21km
                    "totalTime": 600000,     # centiseconds = 6000s
                    "avgSpeed": 286,
                    "avgHr": 150,
                    "maxHr": 175,
                    "avgCadence": 180,
                    "elevGain": 200,
                    "totalDescent": 190,
                    "calories": 1200000,  # cal * 1000
                    "trainingLoad": 120,
                },
                "lapList": [],
                "zoneList": [],
                "frequencyList": [],
            }
        }
        detail = ActivityDetail.from_api(data, "run123")
        assert detail.label_id == "run123"
        assert detail.distance_m == 21000.0  # 21km
        assert detail.duration_s == 6000.0
        assert detail.calories_kcal == 1200
        assert detail.ascent_m == 200
        assert detail.descent_m == 190

    def test_laps_parsing(self):
        data = {
            "data": {
                "summary": {"sportType": 100},
                "lapList": [{
                    "type": 10,
                    "lapItemList": [
                        {"distance": 100000000, "time": 30000, "avgPace": 300, "avgHr": 145},
                        {"distance": 100000000, "time": 29500, "avgPace": 295, "avgHr": 148},
                    ],
                }],
                "zoneList": [],
                "frequencyList": [],
            }
        }
        detail = ActivityDetail.from_api(data, "lap_test")
        assert len(detail.laps) == 2
        assert detail.laps[0].lap_type == "autoKm"
        assert detail.laps[0].lap_index == 1
        assert detail.laps[0].distance_m == 1000.0  # 1km

    def test_zones_parsing(self):
        data = {
            "data": {
                "summary": {"sportType": 100},
                "lapList": [],
                "zoneList": [{
                    "zoneType": 2,
                    "zoneItemList": [
                        {"zoneIndex": 0, "leftScope": 100, "rightScope": 120, "second": 600, "percent": 20},
                        {"zoneIndex": 1, "leftScope": 120, "rightScope": 140, "second": 1200, "percent": 40},
                    ],
                }],
                "frequencyList": [],
            }
        }
        detail = ActivityDetail.from_api(data, "zone_test")
        assert len(detail.zones) == 2
        assert detail.zones[0].zone_type == "heartRate"
        assert detail.zones[0].zone_index == 1
        assert detail.zones[0].range_unit == "bpm"


class TestDailyHealthFromApi:
    def test_conversion(self):
        data = {
            "date": "20260315",
            "ati": 45.5,
            "cti": 38.2,
            "rhr": 52,
            "distance": 10000,
            "duration": 3000,
            "trainingLoadRatio": 1.2,
            "trainingLoadRatioState": 2,
            "fatigue": 30,
        }
        h = DailyHealth.from_api(data)
        assert h.date == "20260315"
        assert h.ati == 45.5
        assert h.rhr == 52
        assert h.training_load_state == "Optimal"


class TestDashboardFromApi:
    def test_conversion(self):
        summary = {
            "staminaLevel": 65.0,
            "aerobicEnduranceScore": 70,
            "lactateThresholdCapacityScore": 55,
            "anaerobicEnduranceScore": 40,
            "anaerobicCapacityScore": 35,
            "rhr": 52,
            "lthr": 165,
            "ltsp": 280,
            "recoveryPct": 85,
            "sleepHrvData": {
                "avgSleepHrv": 55,
                "sleepHrvAllIntervalList": [10, 20, 40, 70],
            },
            "runScoreList": [
                {"type": 1, "duration": 1200, "avgPace": 240},
                {"type": 4, "duration": 12600, "avgPace": 300},
            ],
        }
        week = {"distanceRecord": 50000, "durationRecord": 18000}

        d = Dashboard.from_api(summary, week)
        assert d.running_level == 65.0
        assert d.avg_sleep_hrv == 55
        assert d.hrv_normal_low == 40
        assert d.hrv_normal_high == 70
        assert d.weekly_distance_m == 50000
        assert len(d.race_predictions) == 2
        assert d.race_predictions[0].race_type == "5K"
        assert d.race_predictions[1].race_type == "Marathon"
