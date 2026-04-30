"""Garmin API JSON → stride_core domain models.

Garmin uses different units and field names from COROS. This module is the
single boundary where those differences get normalized — same role
`coros_sync.models` plays for COROS, except since `stride_core.models`
already exposes the dataclasses, we just provide builder functions here
rather than redefining the dataclasses.

Unit conventions (Garmin vs our internal):
- distance: meters       (Garmin) → meters     (us) ✅ no conversion
- duration: seconds      (Garmin) → seconds    (us) ✅ no conversion
- speed:    m/s          (Garmin) → s/km       (us) → 1000 / m_s
- calories: kcal         (Garmin) → kcal       (us) ✅ no conversion
- pace.zone target: m/s  (Garmin) → s/km       (us) → 1000 / m_s

Garmin sport_type doesn't exist as an int; we synthesize one to fit the
existing `activities.sport_type INTEGER NOT NULL` column. We use a deliberate
8000-range so it can't collide with COROS's int codes (max 10004), and the
human-readable `sport_name` carries the Garmin typeKey for diagnostics.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from stride_core.models import (
    ActivityDetail,
    DailyHealth,
    Dashboard,
    Lap,
    RacePrediction,
    TimeseriesPoint,
    Zone,
)


# ─────────────────────────────────────────────────────────────────────────────
# Synthetic sport_type ints for Garmin-sourced rows
# ─────────────────────────────────────────────────────────────────────────────
#
# COROS uses 100/101/.../10004. We use 8000+ so a row's int unambiguously
# identifies its provider during forensic SQL queries (rare but useful).

_GARMIN_SPORT_TYPE_BASE = 8000
_GARMIN_TYPEKEY_TO_INT: dict[str, int] = {
    "running": 8001,
    "indoor_running": 8002,
    "treadmill_running": 8003,
    "track_running": 8004,
    "trail_running": 8005,
    "walking": 8010,
    "hiking": 8011,
    "cycling": 8020,
    "indoor_cycling": 8021,
    "gravel_cycling": 8022,
    "mountain_biking": 8023,
    "road_biking": 8024,
    "lap_swimming": 8030,
    "open_water_swimming": 8031,
    "strength_training": 8040,
    "cardio": 8050,
    "elliptical": 8051,
    "stair_climbing": 8052,
    "fitness_equipment": 8053,
    "hiit": 8054,
    "indoor_rowing": 8055,
    "rowing": 8056,
    "yoga": 8060,
    "pilates": 8061,
    "mobility": 8062,
    "multi_sport": 8070,
    "triathlon": 8071,
}


def synthetic_sport_type(type_key: str | None) -> int:
    """Map Garmin typeKey → stable int for the activities.sport_type column."""
    if not type_key:
        return _GARMIN_SPORT_TYPE_BASE
    return _GARMIN_TYPEKEY_TO_INT.get(type_key, _GARMIN_SPORT_TYPE_BASE)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _ms_to_pace_s_km(speed_m_s: float | None) -> float | None:
    if not speed_m_s or speed_m_s <= 0:
        return None
    return 1000.0 / float(speed_m_s)


def _gmt_to_iso(start_time_gmt: str | None) -> str | None:
    """Garmin returns 'YYYY-MM-DD HH:MM:SS' in GMT. Convert to ISO with +00:00."""
    if not start_time_gmt:
        return None
    try:
        dt = datetime.strptime(start_time_gmt, "%Y-%m-%d %H:%M:%S")
        return dt.replace(tzinfo=timezone.utc).isoformat()
    except (TypeError, ValueError):
        return start_time_gmt  # let caller see the raw string if format changes


# ─────────────────────────────────────────────────────────────────────────────
# Activity detail builder
# ─────────────────────────────────────────────────────────────────────────────


def activity_detail_from_garmin(
    activity_summary: dict[str, Any],
    *,
    splits: dict[str, Any] | None = None,
    hr_zones: list[dict[str, Any]] | None = None,
    weather: dict[str, Any] | None = None,
    timeseries_points: list[TimeseriesPoint] | None = None,
) -> ActivityDetail:
    """Build an `ActivityDetail` from Garmin's activity summary + sub-resources.

    `activity_summary` is the dict returned by `get_activity` /
    `get_activities()[i]`. The sub-resource dicts (splits, hr_zones, weather)
    are optional — they're populated when the caller wants the full detail.
    `timeseries_points` is also optional and typically heavy; sync v1 leaves
    it empty (we can backfill from FIT files in a later phase).
    """
    a = activity_summary
    activity_type = a.get("activityType") or {}
    type_key = activity_type.get("typeKey")

    label_id = str(a.get("activityId", ""))

    laps = _build_laps_from_splits(splits) if splits else []
    zones = _build_hr_zones(hr_zones) if hr_zones else []

    weather = weather or {}

    return ActivityDetail(
        label_id=label_id,
        name=a.get("activityName"),
        sport_type=synthetic_sport_type(type_key),
        sport_name=type_key or "Unknown",
        date=_gmt_to_iso(a.get("startTimeGMT")),
        distance_m=float(a.get("distance") or 0.0),
        duration_s=float(a.get("duration") or 0.0),
        avg_pace_s_km=_ms_to_pace_s_km(a.get("averageSpeed")),
        adjusted_pace=None,
        best_km_pace=None,
        max_pace=_ms_to_pace_s_km(a.get("maxSpeed")),
        avg_hr=int(a["averageHR"]) if a.get("averageHR") is not None else None,
        max_hr=int(a["maxHR"]) if a.get("maxHR") is not None else None,
        avg_cadence=int(a["averageRunningCadenceInStepsPerMinute"])
            if a.get("averageRunningCadenceInStepsPerMinute") is not None else None,
        max_cadence=int(a["maxRunningCadenceInStepsPerMinute"])
            if a.get("maxRunningCadenceInStepsPerMinute") is not None else None,
        avg_power=int(a["avgPower"]) if a.get("avgPower") is not None else None,
        max_power=int(a["maxPower"]) if a.get("maxPower") is not None else None,
        avg_step_len_cm=a.get("avgStrideLength"),
        ascent_m=a.get("elevationGain"),
        descent_m=a.get("elevationLoss"),
        calories_kcal=int(a["calories"]) if a.get("calories") is not None else None,
        aerobic_effect=a.get("aerobicTrainingEffect"),
        anaerobic_effect=a.get("anaerobicTrainingEffect"),
        training_load=a.get("activityTrainingLoad"),
        vo2max=a.get("vO2MaxValue"),
        performance=None,
        # train_type stays as the Garmin label string for back-compat with
        # readers that grep this column for substrings (ability.py heuristics).
        # The provider-agnostic train_kind is filled by normalize.apply_to_detail.
        train_type=a.get("trainingEffectLabel"),
        temperature=weather.get("temp"),
        humidity=weather.get("relativeHumidity"),
        feels_like=weather.get("apparentTemp"),
        wind_speed=weather.get("windSpeed"),
        feel_type=int(a["feel"]) if a.get("feel") not in (None, 0) else None,
        sport_note=a.get("description") or None,
        laps=laps,
        zones=zones,
        timeseries=list(timeseries_points or []),
    )


def _build_laps_from_splits(splits: dict[str, Any]) -> list[Lap]:
    """Garmin splits → list[Lap]. `splits` is the dict from get_activity_splits."""
    out: list[Lap] = []
    rows = splits.get("lapDTOs") or []
    for i, lap in enumerate(rows, start=1):
        out.append(Lap(
            lap_index=int(lap.get("lapIndex", i)),
            lap_type="autoKm",   # Garmin auto-laps ~ 1km
            distance_m=float(lap.get("distance") or 0.0),
            duration_s=float(lap.get("duration") or 0.0),
            avg_pace=_ms_to_pace_s_km(lap.get("averageSpeed")),
            adjusted_pace=_ms_to_pace_s_km(lap.get("avgGradeAdjustedSpeed")),
            avg_hr=int(lap["averageHR"]) if lap.get("averageHR") is not None else None,
            max_hr=int(lap["maxHR"]) if lap.get("maxHR") is not None else None,
            avg_cadence=int(lap["averageRunCadence"]) if lap.get("averageRunCadence") is not None else None,
            avg_power=int(lap["averagePower"]) if lap.get("averagePower") is not None else None,
            ascent_m=lap.get("elevationGain"),
            descent_m=lap.get("elevationLoss"),
            exercise_type=None,
            exercise_name_key=None,
            mode=None,
        ))
    return out


def _build_hr_zones(hr_zones_data: list[dict[str, Any]]) -> list[Zone]:
    """Garmin HR zones list → list[Zone]."""
    out: list[Zone] = []
    for entry in hr_zones_data:
        out.append(Zone(
            zone_type="heartRate",
            zone_index=int(entry.get("zoneNumber", 0)),
            range_min=entry.get("zoneLowBoundary"),
            range_max=None,  # Garmin only gives the lower boundary
            range_unit="bpm",
            duration_s=int(entry.get("secsInZone") or 0),
            percent=0.0,  # caller can compute from secsInZone / total if needed
        ))
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Daily health
# ─────────────────────────────────────────────────────────────────────────────


def daily_health_from_garmin(
    *,
    date_iso: str,
    training_status: dict[str, Any] | None = None,
    user_summary: dict[str, Any] | None = None,
) -> DailyHealth:
    """Build a `DailyHealth` row for `date_iso` from Garmin endpoints.

    Pulls from:
      - training_status.mostRecentTrainingStatus.acuteTrainingLoadDTO →
        ATI / CTI / training_load_ratio / training_load_state
      - user_summary.restingHeartRate or training_status.* → RHR
    Garmin doesn't expose a direct equivalent of COROS's `fatigue` (tiredRate),
    so that field stays None.
    """
    ati: float | None = None
    cti: float | None = None
    ratio: float | None = None
    state: str | None = None
    rhr: int | None = None

    ts = (training_status or {}).get("mostRecentTrainingStatus") or {}
    devices_map = ts.get("latestTrainingStatusData") or {}
    if devices_map:
        # Garmin keys this by deviceId — pick the primary or just the first.
        primary = next(
            (v for v in devices_map.values() if v.get("primaryTrainingDevice")),
            next(iter(devices_map.values()), {}),
        )
        load = primary.get("acuteTrainingLoadDTO") or {}
        ati = load.get("dailyTrainingLoadAcute")
        cti = load.get("dailyTrainingLoadChronic")
        ratio = load.get("dailyAcuteChronicWorkloadRatio")
        state = load.get("acwrStatus")  # 'OPTIMAL' / 'HIGH' / 'LOW' / ...

    if user_summary:
        rhr = user_summary.get("restingHeartRate") or user_summary.get(
            "lastSevenDaysAvgRestingHeartRate"
        )

    return DailyHealth(
        date=date_iso,
        ati=float(ati) if ati is not None else None,
        cti=float(cti) if cti is not None else None,
        rhr=int(rhr) if rhr is not None else None,
        distance_m=None,
        duration_s=None,
        training_load_ratio=float(ratio) if ratio is not None else None,
        training_load_state=state,
        # Garmin has no tiredRate equivalent; defaults to None.
        fatigue=None,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Dashboard (singleton row — running level / threshold / HRV / race predictions)
# ─────────────────────────────────────────────────────────────────────────────


def dashboard_from_garmin(
    *,
    training_status: dict[str, Any] | None = None,
    user_summary: dict[str, Any] | None = None,
    hrv: dict[str, Any] | None = None,
    lactate_threshold: dict[str, Any] | None = None,
    race_predictions: dict[str, Any] | None = None,
) -> Dashboard:
    """Build the singleton `dashboard` row from Garmin endpoints.

    Garmin doesn't have COROS's private endurance/lactate/anaerobic scores,
    so those fields stay None — frontend already treats them as nullable
    per Step 1 design.
    """
    vo2 = (training_status or {}).get("mostRecentVO2Max", {}) or {}
    vo2_generic = vo2.get("generic", {}) or {}

    # threshold from lactate_threshold endpoint
    lt_speed_hr = (lactate_threshold or {}).get("speed_and_heart_rate", {}) or {}
    threshold_hr = lt_speed_hr.get("heartRate")
    # Empirical Garmin quirk: this endpoint reports `speed` at 1/10th of m/s
    # (e.g. 0.4417 for an actual 4.417 m/s). Verified against the test
    # account where heartRate=170 + actual recent runs at LT pace cluster
    # around 3:45-4:00/km — without the *10 scaling we get 37:44/km which
    # is non-physical. Other Garmin endpoints (activity averageSpeed) report
    # genuine m/s, so the scaling is local to this endpoint.
    threshold_speed_m_s = lt_speed_hr.get("speed")
    if threshold_speed_m_s is not None:
        threshold_speed_m_s = float(threshold_speed_m_s) * 10.0
    threshold_pace_s_km = _ms_to_pace_s_km(threshold_speed_m_s)

    # HRV from get_hrv_data
    hrv_summary = (hrv or {}).get("hrvSummary", {}) or {}
    avg_sleep_hrv = hrv_summary.get("lastNightAvg")
    baseline = hrv_summary.get("baseline", {}) or {}
    hrv_normal_low = baseline.get("balancedLow")
    hrv_normal_high = baseline.get("balancedUpper")

    # RHR (prefer 7-day avg if present)
    rhr = (
        (user_summary or {}).get("lastSevenDaysAvgRestingHeartRate")
        or (user_summary or {}).get("restingHeartRate")
    )

    # Race predictions — Garmin returns a single dict with 4 distance fields
    rp_dict = race_predictions or {}
    predictions: list[RacePrediction] = []
    for key, label in (
        ("time5K", "5K"),
        ("time10K", "10K"),
        ("timeHalfMarathon", "Half Marathon"),
        ("timeMarathon", "Marathon"),
    ):
        seconds = rp_dict.get(key)
        if seconds:
            predictions.append(
                RacePrediction(race_type=label, duration_s=float(seconds), avg_pace=None)
            )

    return Dashboard(
        running_level=None,                # Garmin: no direct equivalent
        aerobic_score=None,                # COROS-private
        lactate_threshold_score=None,      # COROS-private
        anaerobic_endurance_score=None,    # COROS-private
        anaerobic_capacity_score=None,     # COROS-private
        rhr=int(rhr) if rhr is not None else None,
        threshold_hr=int(threshold_hr) if threshold_hr is not None else None,
        threshold_pace_s_km=threshold_pace_s_km,
        recovery_pct=None,                 # Could derive from Body Battery later
        avg_sleep_hrv=float(avg_sleep_hrv) if avg_sleep_hrv is not None else None,
        hrv_normal_low=float(hrv_normal_low) if hrv_normal_low is not None else None,
        hrv_normal_high=float(hrv_normal_high) if hrv_normal_high is not None else None,
        weekly_distance_m=None,
        weekly_duration_s=None,
        race_predictions=predictions,
    )
