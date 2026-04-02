"""Data models with from_api() classmethods as the sole unit-conversion boundary."""

from __future__ import annotations

from dataclasses import dataclass, field

# Sport type mappings (from coros-cli reference)
SPORT_TYPES: dict[int, str] = {
    100: "Run", 101: "Indoor Run", 102: "Trail Run", 103: "Track Run", 104: "Treadmill",
    200: "Bike", 201: "Indoor Bike", 202: "E-Bike", 203: "Gravel Bike",
    300: "Swim (Pool)", 301: "Swim (Open Water)",
    400: "Triathlon", 401: "Multisport", 402: "Strength Training",
    500: "Cardio", 501: "Gym", 502: "HIIT", 503: "Jump Rope", 504: "Rowing",
    600: "Walk", 601: "Hike",
    700: "Ski", 701: "Snowboard", 702: "XC Ski", 703: "Ski Touring",
    800: "Strength",
    1005: "Tennis",
    10000: "GPS Cardio", 10001: "Flatwater", 10002: "Whitewater",
    10003: "Windsurfing", 10004: "Speedsurfing",
}

TRAIN_TYPES: dict[int, str] = {
    1: "Base", 2: "Aerobic Endurance", 3: "Threshold", 4: "Interval",
    5: "VO2 Max", 6: "Anaerobic", 7: "Sprint", 8: "Recovery",
}

RACE_TYPES: dict[int, str] = {
    1: "5K", 2: "10K", 3: "Half Marathon", 4: "Marathon",
}

RUN_SPORT_IDS = {100, 101, 102, 103, 104, 600, 601}

TRAINING_LOAD_STATES: dict[int, str] = {
    0: "Unknown", 1: "Low", 2: "Optimal", 3: "High", 4: "Very High",
}


def sport_name(sport_type: int) -> str:
    return SPORT_TYPES.get(sport_type, f"Unknown ({sport_type})")


def train_type_name(train_type: int) -> str:
    return TRAIN_TYPES.get(train_type, f"Unknown ({train_type})")


def pace_str(s_per_km: float | None) -> str | None:
    if not s_per_km:
        return None
    m = int(s_per_km) // 60
    s = int(s_per_km) % 60
    return f"{m}:{s:02d}/km"


@dataclass
class Activity:
    """Activity summary from /activity/query list endpoint."""
    label_id: str
    name: str | None
    sport_type: int
    sport_name: str
    date: str
    distance_m: float
    duration_s: float
    avg_pace_s_km: float | None
    avg_hr: int | None
    ascent_m: float | None
    calories_kcal: int | None
    training_load: float | None
    device: str | None

    @classmethod
    def from_api(cls, data: dict) -> Activity:
        return cls(
            label_id=data["labelId"],
            name=data.get("name"),
            sport_type=data.get("sportType", 0),
            sport_name=sport_name(data.get("sportType", 0)),
            date=str(data.get("date", "")),
            distance_m=data.get("distance", 0),
            duration_s=data.get("totalTime", 0),
            avg_pace_s_km=data.get("avgSpeed"),
            avg_hr=data.get("avgHr"),
            ascent_m=data.get("ascent"),
            calories_kcal=round(data["calorie"] / 1000) if data.get("calorie") else None,
            training_load=data.get("trainingLoad"),
            device=data.get("device"),
        )


@dataclass
class Lap:
    lap_index: int
    lap_type: str
    distance_m: float
    duration_s: float
    avg_pace: float | None
    adjusted_pace: float | None
    avg_hr: int | None
    max_hr: int | None
    avg_cadence: int | None
    avg_power: int | None
    ascent_m: float | None
    descent_m: float | None

    @classmethod
    def from_api(cls, data: dict, index: int, lap_type: str) -> Lap:
        return cls(
            lap_index=index,
            lap_type=lap_type,
            distance_m=round((data.get("distance", 0)) / 100_000, 2),
            duration_s=round((data.get("time", 0)) / 100, 2),
            avg_pace=data.get("avgPace"),
            adjusted_pace=data.get("adjustedPace"),
            avg_hr=data.get("avgHr"),
            max_hr=data.get("maxHr"),
            avg_cadence=data.get("avgCadence"),
            avg_power=data.get("avgPower"),
            ascent_m=data.get("elevGain"),
            descent_m=data.get("totalDescent"),
        )


@dataclass
class Zone:
    zone_type: str  # "heartRate" or "pace"
    zone_index: int
    range_min: float | None
    range_max: float | None
    range_unit: str  # "bpm" or "pace"
    duration_s: int
    percent: float

    @classmethod
    def from_api(cls, data: dict, zone_type_id: int) -> Zone:
        is_pace = zone_type_id == 1
        zone_type = "pace" if is_pace else "heartRate"
        return cls(
            zone_type=zone_type,
            zone_index=(data.get("zoneIndex", 0)) + 1,
            range_min=data.get("rightScope") if is_pace else data.get("leftScope"),
            range_max=data.get("leftScope") if is_pace else data.get("rightScope"),
            range_unit="pace" if is_pace else "bpm",
            duration_s=data.get("second", 0),
            percent=data.get("percent", 0),
        )


@dataclass
class TimeseriesPoint:
    timestamp: int | None
    distance: float | None
    heart_rate: int | None
    speed: float | None
    adjusted_pace: float | None
    cadence: int | None
    altitude: float | None
    power: int | None

    @classmethod
    def from_api(cls, data: dict) -> TimeseriesPoint:
        return cls(
            timestamp=data.get("timestamp"),
            distance=data.get("distance"),
            heart_rate=data.get("heart"),
            speed=data.get("speed"),
            adjusted_pace=data.get("adjustedPace"),
            cadence=data.get("cadence"),
            altitude=data.get("altitude"),
            power=data.get("power"),
        )


@dataclass
class ActivityDetail:
    """Full activity detail from /activity/detail/query."""
    label_id: str
    name: str | None
    sport_type: int
    sport_name: str
    date: str | None
    distance_m: float
    duration_s: float
    avg_pace_s_km: float | None
    adjusted_pace: float | None
    best_km_pace: float | None
    max_pace: float | None
    avg_hr: int | None
    max_hr: int | None
    avg_cadence: int | None
    max_cadence: int | None
    avg_power: int | None
    max_power: int | None
    avg_step_len_cm: float | None
    ascent_m: float | None
    descent_m: float | None
    calories_kcal: int | None
    aerobic_effect: float | None
    anaerobic_effect: float | None
    training_load: float | None
    vo2max: float | None
    performance: float | None
    train_type: str | None
    laps: list[Lap] = field(default_factory=list)
    zones: list[Zone] = field(default_factory=list)
    timeseries: list[TimeseriesPoint] = field(default_factory=list)

    @classmethod
    def from_api(cls, data: dict, label_id: str) -> ActivityDetail:
        detail = data.get("data", {})
        s = detail.get("summary", {})
        st = s.get("sportType", 0)

        # Parse laps
        laps: list[Lap] = []
        for group in detail.get("lapList", []):
            if group.get("type") == -1:
                continue
            type_id = group.get("type", 0)
            lap_type = {10: "autoKm", 11: "autoMile"}.get(type_id, f"type{type_id}")
            for i, lap_data in enumerate(group.get("lapItemList", [])):
                laps.append(Lap.from_api(lap_data, i + 1, lap_type))

        # Parse zones
        zones: list[Zone] = []
        for group in detail.get("zoneList", []):
            zone_type_id = group.get("zoneType", 0)
            for item in group.get("zoneItemList", []):
                zones.append(Zone.from_api(item, zone_type_id))

        # Parse timeseries
        timeseries = [
            TimeseriesPoint.from_api(p) for p in detail.get("frequencyList", [])
        ]

        # Convert timestamp to ISO date
        start_ts = s.get("startTimestamp")
        date = None
        if start_ts:
            from datetime import datetime, timezone
            date = datetime.fromtimestamp(start_ts / 100, tz=timezone.utc).isoformat()

        return cls(
            label_id=label_id,
            name=s.get("name"),
            sport_type=st,
            sport_name=sport_name(st),
            date=date,
            distance_m=round((s.get("distance", 0)) / 100_000, 2),
            duration_s=round((s.get("totalTime", 0)) / 100, 2),
            avg_pace_s_km=s.get("avgSpeed"),
            adjusted_pace=s.get("adjustedPace"),
            best_km_pace=s.get("bestKm"),
            max_pace=s.get("maxSpeed"),
            avg_hr=s.get("avgHr"),
            max_hr=s.get("maxHr"),
            avg_cadence=s.get("avgCadence"),
            max_cadence=s.get("maxCadence"),
            avg_power=s.get("avgPower"),
            max_power=s.get("maxPower"),
            avg_step_len_cm=s.get("avgStepLen"),
            ascent_m=s.get("elevGain"),
            descent_m=s.get("totalDescent"),
            calories_kcal=round(s["calories"] / 1000) if s.get("calories") else None,
            aerobic_effect=s.get("aerobicEffect"),
            anaerobic_effect=s.get("anaerobicEffect"),
            training_load=s.get("trainingLoad"),
            vo2max=s.get("currentVo2Max"),
            performance=s.get("performance"),
            train_type=train_type_name(s["trainType"]) if s.get("trainType") else None,
            laps=laps,
            zones=zones,
            timeseries=timeseries,
        )


@dataclass
class DailyHealth:
    date: str
    ati: float | None
    cti: float | None
    rhr: int | None
    distance_m: float | None
    duration_s: float | None
    training_load_ratio: float | None
    training_load_state: str | None
    fatigue: float | None

    @classmethod
    def from_api(cls, data: dict) -> DailyHealth:
        state_id = data.get("trainingLoadRatioState", 0)
        return cls(
            date=str(data.get("happenDay", data.get("date", ""))),
            ati=data.get("ati"),
            cti=data.get("cti"),
            rhr=data.get("rhr"),
            distance_m=data.get("distance"),
            duration_s=data.get("duration"),
            training_load_ratio=data.get("trainingLoadRatio"),
            training_load_state=TRAINING_LOAD_STATES.get(state_id, f"Unknown ({state_id})"),
            fatigue=data.get("tiredRate", data.get("fatigue")),
        )


@dataclass
class RacePrediction:
    race_type: str
    duration_s: float | None
    avg_pace: float | None

    @classmethod
    def from_api(cls, data: dict) -> RacePrediction:
        return cls(
            race_type=RACE_TYPES.get(data.get("type", 0), f"Unknown ({data.get('type')})"),
            duration_s=data.get("duration"),
            avg_pace=data.get("avgPace"),
        )


@dataclass
class Dashboard:
    running_level: float | None
    aerobic_score: float | None
    lactate_threshold_score: float | None
    anaerobic_endurance_score: float | None
    anaerobic_capacity_score: float | None
    rhr: int | None
    threshold_hr: int | None
    threshold_pace_s_km: float | None
    recovery_pct: float | None
    avg_sleep_hrv: float | None
    hrv_normal_low: float | None
    hrv_normal_high: float | None
    weekly_distance_m: float | None
    weekly_duration_s: float | None
    race_predictions: list[RacePrediction] = field(default_factory=list)

    @classmethod
    def from_api(cls, summary: dict, week: dict | None = None) -> Dashboard:
        hrv_data = summary.get("sleepHrvData", {})
        intervals = hrv_data.get("sleepHrvAllIntervalList", [])
        predictions = [
            RacePrediction.from_api(r) for r in summary.get("runScoreList", [])
        ]
        week = week or {}
        dist = week.get("distanceRecord")
        dur = week.get("durationRecord")
        return cls(
            running_level=summary.get("staminaLevel"),
            aerobic_score=summary.get("aerobicEnduranceScore"),
            lactate_threshold_score=summary.get("lactateThresholdCapacityScore"),
            anaerobic_endurance_score=summary.get("anaerobicEnduranceScore"),
            anaerobic_capacity_score=summary.get("anaerobicCapacityScore"),
            rhr=summary.get("rhr"),
            threshold_hr=summary.get("lthr"),
            threshold_pace_s_km=summary.get("ltsp"),
            recovery_pct=summary.get("recoveryPct"),
            avg_sleep_hrv=hrv_data.get("avgSleepHrv"),
            hrv_normal_low=intervals[2] if len(intervals) >= 4 else None,
            hrv_normal_high=intervals[3] if len(intervals) >= 4 else None,
            weekly_distance_m=dist if isinstance(dist, (int, float)) else None,
            weekly_duration_s=dur if isinstance(dur, (int, float)) else None,
            race_predictions=predictions,
        )
