"""Tests for garmin_sync.models — Garmin JSON → stride_core dataclasses."""

from __future__ import annotations

from garmin_sync.models import (
    activity_detail_from_garmin,
    daily_health_from_garmin,
    dashboard_from_garmin,
    synthetic_sport_type,
)


# ─────────────────────────────────────────────────────────────────────────────
# Synthetic sport_type ints stay in the 8000-range (no collision with COROS)
# ─────────────────────────────────────────────────────────────────────────────


class TestSyntheticSportType:
    def test_known_keys_are_distinct_8k_values(self):
        codes = {
            synthetic_sport_type("running"),
            synthetic_sport_type("strength_training"),
            synthetic_sport_type("cycling"),
            synthetic_sport_type("lap_swimming"),
        }
        assert len(codes) == 4
        assert all(c >= 8000 for c in codes)

    def test_unknown_key_falls_back_to_base(self):
        # Anything not in the table maps to the 8000 base sentinel
        assert synthetic_sport_type("paragliding") == 8000
        assert synthetic_sport_type(None) == 8000


# ─────────────────────────────────────────────────────────────────────────────
# activity_detail_from_garmin — built from a recon-shaped sample
# ─────────────────────────────────────────────────────────────────────────────


def _sample_activity():
    """Mirror of the friend's Garmin recon last_activity shape."""
    return {
        "activityId": 589314738,
        "activityName": "青浦区 跑步",
        "startTimeGMT": "2026-04-29 06:38:46",
        "activityType": {"typeKey": "running", "typeId": 1},
        "distance": 13061.24,
        "duration": 3600.3,
        "averageSpeed": 3.628,           # m/s
        "maxSpeed": 4.32,                # m/s
        "averageHR": 143,
        "maxHR": 152,
        "averageRunningCadenceInStepsPerMinute": 180.96,
        "maxRunningCadenceInStepsPerMinute": 192.0,
        "avgPower": 347,
        "maxPower": 451,
        "avgStrideLength": 119.27,
        "aerobicTrainingEffect": 3.7,
        "anaerobicTrainingEffect": 0.0,
        "trainingEffectLabel": "AEROBIC_BASE",
        "activityTrainingLoad": 157.89,
        "vO2MaxValue": 60.0,
        "calories": 848,
        "elevationGain": 21.0,
        "elevationLoss": 16.0,
        "feel": 70,
        "description": "周二 tempo 跑",
    }


class TestActivityDetailBuilder:
    def test_label_id_stringified(self):
        d = activity_detail_from_garmin(_sample_activity())
        assert d.label_id == "589314738"

    def test_units_already_si(self):
        d = activity_detail_from_garmin(_sample_activity())
        # Distance/duration come through unchanged (Garmin already meters/sec)
        assert d.distance_m == 13061.24
        assert d.duration_s == 3600.3
        # Calories pass through (kcal)
        assert d.calories_kcal == 848

    def test_pace_converts_m_s_to_s_km(self):
        d = activity_detail_from_garmin(_sample_activity())
        # 3.628 m/s → 1000/3.628 ≈ 275.63 s/km
        assert d.avg_pace_s_km is not None
        assert 274 < d.avg_pace_s_km < 277

    def test_max_pace_from_max_speed(self):
        d = activity_detail_from_garmin(_sample_activity())
        # 4.32 m/s → 1000/4.32 ≈ 231.48 s/km
        assert d.max_pace is not None
        assert 230 < d.max_pace < 233

    def test_train_type_keeps_garmin_label(self):
        d = activity_detail_from_garmin(_sample_activity())
        # train_type column gets the Garmin label string for back-compat;
        # the normalized train_kind is filled separately by apply_to_detail.
        assert d.train_type == "AEROBIC_BASE"

    def test_synthetic_sport_type_in_8000_range(self):
        d = activity_detail_from_garmin(_sample_activity())
        assert d.sport_type == 8001  # 'running'
        assert d.sport_name == "running"

    def test_date_iso_with_timezone(self):
        d = activity_detail_from_garmin(_sample_activity())
        # Garmin gives 'YYYY-MM-DD HH:MM:SS' GMT; we emit ISO with UTC offset.
        assert d.date is not None
        assert "2026-04-29" in d.date
        assert "+00:00" in d.date

    def test_zero_feel_dropped(self):
        sample = _sample_activity()
        sample["feel"] = 0
        d = activity_detail_from_garmin(sample)
        assert d.feel_type is None

    def test_sport_note_mapped_from_description(self):
        d = activity_detail_from_garmin(_sample_activity())
        assert d.sport_note == "周二 tempo 跑"

    def test_running_form_metrics_passthrough(self):
        d = activity_detail_from_garmin(_sample_activity())
        # avgStrideLength → avg_step_len_cm (Garmin's name → ours)
        assert d.avg_step_len_cm == 119.27

    def test_empty_optional_subresources(self):
        # Builder should be fully usable with just the activity dict.
        d = activity_detail_from_garmin(_sample_activity())
        assert d.laps == []
        assert d.zones == []
        assert d.timeseries == []

    def test_with_splits_produces_laps(self):
        sample = _sample_activity()
        splits = {
            "lapDTOs": [
                {
                    "lapIndex": 1,
                    "distance": 1000.0,
                    "duration": 293.0,
                    "averageSpeed": 3.4,
                    "averageHR": 123,
                    "maxHR": 139,
                    "averageRunCadence": 178,
                    "averagePower": 322,
                    "elevationGain": 4.0,
                    "elevationLoss": 0.0,
                },
            ],
        }
        d = activity_detail_from_garmin(sample, splits=splits)
        assert len(d.laps) == 1
        lap = d.laps[0]
        assert lap.lap_index == 1
        assert lap.distance_m == 1000.0
        assert lap.duration_s == 293.0
        # Pace converted from m/s
        assert lap.avg_pace is not None and 290 < lap.avg_pace < 300

    def test_with_hr_zones(self):
        sample = _sample_activity()
        zones = [
            {"zoneNumber": 1, "secsInZone": 25, "zoneLowBoundary": 91},
            {"zoneNumber": 2, "secsInZone": 100, "zoneLowBoundary": 110},
        ]
        d = activity_detail_from_garmin(sample, hr_zones=zones)
        assert len(d.zones) == 2
        assert d.zones[0].zone_index == 1
        assert d.zones[0].duration_s == 25
        assert d.zones[0].range_unit == "bpm"


# ─────────────────────────────────────────────────────────────────────────────
# daily_health_from_garmin
# ─────────────────────────────────────────────────────────────────────────────


def _sample_training_status():
    return {
        "mostRecentTrainingStatus": {
            "latestTrainingStatusData": {
                "3478181222": {
                    "primaryTrainingDevice": True,
                    "acuteTrainingLoadDTO": {
                        "dailyTrainingLoadAcute": 856,
                        "dailyTrainingLoadChronic": 905,
                        "dailyAcuteChronicWorkloadRatio": 0.9,
                        "acwrStatus": "OPTIMAL",
                    },
                },
            },
        },
        "mostRecentVO2Max": {
            "generic": {"vo2MaxValue": 61.0, "vo2MaxPreciseValue": 60.5},
        },
    }


class TestDailyHealthBuilder:
    def test_loads_acute_chronic_ratio(self):
        h = daily_health_from_garmin(
            date_iso="2026-04-30",
            training_status=_sample_training_status(),
            user_summary={"restingHeartRate": 49, "lastSevenDaysAvgRestingHeartRate": 45},
        )
        assert h.date == "2026-04-30"
        assert h.ati == 856
        assert h.cti == 905
        assert h.training_load_ratio == 0.9
        assert h.training_load_state == "OPTIMAL"
        assert h.rhr == 49

    def test_fatigue_is_none(self):
        # Garmin has no direct equivalent of COROS tiredRate.
        h = daily_health_from_garmin(
            date_iso="2026-04-30",
            training_status=_sample_training_status(),
            user_summary={"restingHeartRate": 49},
        )
        assert h.fatigue is None

    def test_handles_missing_training_status(self):
        h = daily_health_from_garmin(
            date_iso="2026-04-30",
            training_status=None,
            user_summary={"restingHeartRate": 49},
        )
        assert h.ati is None
        assert h.cti is None
        assert h.rhr == 49

    def test_falls_back_to_seven_day_rhr(self):
        h = daily_health_from_garmin(
            date_iso="2026-04-30",
            training_status=None,
            user_summary={"lastSevenDaysAvgRestingHeartRate": 45},
        )
        assert h.rhr == 45


# ─────────────────────────────────────────────────────────────────────────────
# dashboard_from_garmin
# ─────────────────────────────────────────────────────────────────────────────


class TestDashboardBuilder:
    def test_hrv_baseline_extraction(self):
        d = dashboard_from_garmin(
            hrv={
                "hrvSummary": {
                    "lastNightAvg": 125,
                    "weeklyAvg": 104,
                    "baseline": {
                        "balancedLow": 93,
                        "balancedUpper": 129,
                    },
                    "status": "BALANCED",
                },
            },
        )
        assert d.avg_sleep_hrv == 125.0
        assert d.hrv_normal_low == 93.0
        assert d.hrv_normal_high == 129.0

    def test_lt_pace_converted_from_m_s(self):
        d = dashboard_from_garmin(
            lactate_threshold={
                "speed_and_heart_rate": {
                    "speed": 4.5,         # m/s → ~222 s/km
                    "heartRate": 165,
                },
            },
        )
        assert d.threshold_hr == 165
        # 4.5 m/s = 1000/4.5 ≈ 222.22 s/km
        assert d.threshold_pace_s_km is not None
        assert 221 < d.threshold_pace_s_km < 224

    def test_race_predictions(self):
        d = dashboard_from_garmin(
            race_predictions={
                "time5K": 993,
                "time10K": 2122,
                "timeHalfMarathon": 4685,
                "timeMarathon": 10142,
            },
        )
        assert len(d.race_predictions) == 4
        labels = {p.race_type for p in d.race_predictions}
        assert labels == {"5K", "10K", "Half Marathon", "Marathon"}
        m = next(p for p in d.race_predictions if p.race_type == "Marathon")
        assert m.duration_s == 10142.0

    def test_coros_private_scores_left_null(self):
        d = dashboard_from_garmin(
            hrv={"hrvSummary": {"lastNightAvg": 100}},
        )
        assert d.aerobic_score is None
        assert d.lactate_threshold_score is None
        assert d.anaerobic_endurance_score is None
        assert d.anaerobic_capacity_score is None
        assert d.running_level is None
