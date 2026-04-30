"""Tests for garmin_sync.models — Garmin JSON → stride_core dataclasses."""

from __future__ import annotations

from garmin_sync.models import (
    activity_detail_from_garmin,
    daily_health_from_garmin,
    daily_hrv_from_garmin,
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

    def test_phase3_running_form_columns(self):
        # Garmin reports vertical osc / GCT / vertical ratio per activity;
        # Phase 3 surfaces them on ActivityDetail for the new DB columns.
        sample = _sample_activity()
        sample["avgVerticalOscillation"] = 8.72
        sample["avgGroundContactTime"] = 234.4
        sample["avgVerticalRatio"] = 7.31
        d = activity_detail_from_garmin(sample)
        assert d.vertical_oscillation_mm == 8.72
        assert d.ground_contact_time_ms == 234.4
        assert d.vertical_ratio_pct == 7.31

    def test_phase3_running_form_columns_default_none(self):
        # Strength activities or older Garmin watches don't emit these;
        # the dataclass should default to None so the DB writes NULLs.
        sample = _sample_activity()
        for k in ("avgVerticalOscillation", "avgGroundContactTime", "avgVerticalRatio"):
            sample.pop(k, None)
        d = activity_detail_from_garmin(sample)
        assert d.vertical_oscillation_mm is None
        assert d.ground_contact_time_ms is None
        assert d.vertical_ratio_pct is None

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

    def test_phase3_body_battery_and_stress_from_user_summary(self):
        # user_summary on Garmin carries Body Battery + stress + respiration + SpO2
        h = daily_health_from_garmin(
            date_iso="2026-04-29",
            training_status=None,
            user_summary={
                "restingHeartRate": 49,
                "bodyBatteryHighestValue": 78,
                "bodyBatteryLowestValue": 23,
                "averageStressLevel": 28,
                "avgWakingRespirationValue": 14.0,
                "averageSpo2": 96.0,
            },
        )
        assert h.body_battery_high == 78
        assert h.body_battery_low == 23
        assert h.stress_avg == 28
        assert h.respiration_avg == 14.0
        assert h.spo2_avg == 96.0

    def test_phase3_sleep_stages_from_sleep_data(self):
        # Sleep response: stages + score live at the top level of the dict.
        h = daily_health_from_garmin(
            date_iso="2026-04-29",
            training_status=None,
            user_summary={"restingHeartRate": 49},
            sleep_data={
                "sleepTimeSeconds": 28560,
                "deepSleepSeconds": 7080,
                "lightSleepSeconds": 14940,
                "remSleepSeconds": 6540,
                "awakeSleepSeconds": 0,
                "sleepScores": {"overall": {"value": 86}},
            },
        )
        assert h.sleep_total_s == 28560
        assert h.sleep_deep_s == 7080
        assert h.sleep_light_s == 14940
        assert h.sleep_rem_s == 6540
        assert h.sleep_awake_s == 0
        assert h.sleep_score == 86

    def test_phase3_sleep_score_can_be_bare_int(self):
        # Garmin sometimes returns sleepScores.overall as an int directly
        # rather than {"value": int}; both shapes should produce the same row.
        h = daily_health_from_garmin(
            date_iso="2026-04-29",
            user_summary={},
            sleep_data={"sleepTimeSeconds": 25000, "sleepScores": {"overall": 72}},
        )
        assert h.sleep_total_s == 25000
        assert h.sleep_score == 72

    def test_phase3_average_stress_minus_one_means_no_data(self):
        # Garmin uses -1 as a "no data today" sentinel for stress.
        h = daily_health_from_garmin(
            date_iso="2026-04-30",
            user_summary={"averageStressLevel": -1},
        )
        assert h.stress_avg is None


# ─────────────────────────────────────────────────────────────────────────────
# daily_hrv_from_garmin (Phase 3 — new builder)
# ─────────────────────────────────────────────────────────────────────────────


class TestDailyHrvBuilder:
    def test_full_summary_extracted(self):
        # Mirror of friend's recon shape on 2026-04-29.
        hrv = {
            "hrvSummary": {
                "calendarDate": "2026-04-29",
                "weeklyAvg": 104,
                "lastNightAvg": 125,
                "lastNight5MinHigh": 179,
                "baseline": {
                    "lowUpper": 86,
                    "balancedLow": 93,
                    "balancedUpper": 129,
                    "markerValue": 0.4027,
                },
                "status": "BALANCED",
                "feedbackPhrase": "HRV_BALANCED_5",
            },
        }
        h = daily_hrv_from_garmin("2026-04-29", hrv)
        assert h.date == "2026-04-29"
        assert h.weekly_avg == 104
        assert h.last_night_avg == 125
        assert h.last_night_5min_high == 179
        assert h.status == "BALANCED"
        assert h.baseline_low_upper == 86
        assert h.baseline_balanced_low == 93
        assert h.baseline_balanced_upper == 129
        assert h.feedback_phrase == "HRV_BALANCED_5"

    def test_handles_missing_hrv_response(self):
        # Garmin returns None when the user's watch doesn't support HRV (FR55, etc.).
        h = daily_hrv_from_garmin("2026-04-30", None)
        assert h.date == "2026-04-30"
        assert h.weekly_avg is None
        assert h.last_night_avg is None
        assert h.status is None

    def test_handles_partial_summary(self):
        # Some days return summary without baseline (early use of the watch).
        hrv = {"hrvSummary": {"lastNightAvg": 100, "weeklyAvg": 95}}
        h = daily_hrv_from_garmin("2026-04-30", hrv)
        assert h.last_night_avg == 100
        assert h.weekly_avg == 95
        assert h.baseline_balanced_low is None
        assert h.baseline_balanced_upper is None


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
        # Garmin's lactate_threshold endpoint reports speed at 1/10th of m/s
        # (empirical quirk verified against real account). Models layer
        # multiplies by 10 before the standard m/s -> s/km conversion.
        d = dashboard_from_garmin(
            lactate_threshold={
                "speed_and_heart_rate": {
                    # 0.45 in the API → 4.5 m/s actual → ~222 s/km pace
                    "speed": 0.45,
                    "heartRate": 165,
                },
            },
        )
        assert d.threshold_hr == 165
        # 4.5 m/s = 1000/4.5 ≈ 222.22 s/km
        assert d.threshold_pace_s_km is not None
        assert 221 < d.threshold_pace_s_km < 224

    def test_lt_pace_realistic_recon_value(self):
        # Friend's actual recon value: speed=0.4417, heartRate=170.
        # After x10 scaling, real speed = 4.417 m/s -> ~226.4 s/km = 3:46/km.
        d = dashboard_from_garmin(
            lactate_threshold={
                "speed_and_heart_rate": {
                    "speed": 0.44166543,
                    "heartRate": 170,
                },
            },
        )
        assert d.threshold_hr == 170
        assert d.threshold_pace_s_km is not None
        assert 224 < d.threshold_pace_s_km < 229

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
