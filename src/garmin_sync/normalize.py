"""Garmin-specific encoding ↔ stride_core normalized enums.

Activity sport: Garmin uses `activityType.typeKey` (string) like 'running',
'track_running', 'treadmill_running', 'strength_training', etc. We map these
to NormalizedSport — same enum the COROS adapter targets.

Train kind: Garmin emits `trainingEffectLabel` (string) like 'AEROBIC_BASE',
'TEMPO', 'ANAEROBIC_CAPACITY'. Map to TrainKind.

Feel: Garmin uses an integer 0-100 (post-run feel). Scale ÷10 onto the
unified 0-10 numeric feel scale.

Synthesis from training data is *not* done here (Garmin gives us the labels
directly, unlike COROS's int trainType which we map via lookup).
"""

from __future__ import annotations

from typing import Any

from stride_core.models import ActivityDetail
from stride_core.normalize import (
    Mapper,
    NormalizedSport,
    TrainKind,
)


# ─────────────────────────────────────────────────────────────────────────────
# Garmin activityType.typeKey → NormalizedSport
# ─────────────────────────────────────────────────────────────────────────────
#
# Sourced from Garmin's activity_types_catalog endpoint (152 entries).
# We cover the running family + common cross-training types; anything
# else falls back to UNKNOWN, which is the signal to look at the raw
# typeKey for diagnosis.

GARMIN_SPORT_MAP: Mapper[str, NormalizedSport] = Mapper(
    {
        # Running family
        "running": NormalizedSport.RUN_OUTDOOR,
        "indoor_running": NormalizedSport.RUN_INDOOR,
        "treadmill_running": NormalizedSport.RUN_TREADMILL,
        "track_running": NormalizedSport.RUN_TRACK,
        "trail_running": NormalizedSport.RUN_TRAIL,
        # Walking / hiking
        "walking": NormalizedSport.WALK,
        "hiking": NormalizedSport.HIKE,
        # Cycling
        "cycling": NormalizedSport.BIKE_OUTDOOR,
        "indoor_cycling": NormalizedSport.BIKE_INDOOR,
        "gravel_cycling": NormalizedSport.BIKE_GRAVEL,
        "e_bike_fitness": NormalizedSport.BIKE_E,
        "mountain_biking": NormalizedSport.BIKE_OUTDOOR,
        "road_biking": NormalizedSport.BIKE_OUTDOOR,
        # Swimming
        "lap_swimming": NormalizedSport.SWIM_POOL,
        "open_water_swimming": NormalizedSport.SWIM_OPEN,
        # Strength / fitness
        "strength_training": NormalizedSport.STRENGTH,
        "cardio": NormalizedSport.CARDIO,
        "elliptical": NormalizedSport.CARDIO,
        "stair_climbing": NormalizedSport.CARDIO,
        "fitness_equipment": NormalizedSport.GYM,
        "hiit": NormalizedSport.HIIT,
        "indoor_rowing": NormalizedSport.ROWING,
        "rowing": NormalizedSport.ROWING,
        "yoga": NormalizedSport.STRENGTH,
        "pilates": NormalizedSport.STRENGTH,
        "mobility": NormalizedSport.STRENGTH,
        # Multisport
        "multi_sport": NormalizedSport.MULTISPORT,
        "triathlon": NormalizedSport.TRIATHLON,
        # Snow
        "resort_skiing_snowboarding": NormalizedSport.SKI_DOWNHILL,
        "skate_skiing": NormalizedSport.SKI_XC,
        "cross_country_skiing": NormalizedSport.SKI_XC,
        "backcountry_skiing": NormalizedSport.SKI_TOURING,
        # Misc
        "tennis": NormalizedSport.TENNIS,
    },
    unknown=NormalizedSport.UNKNOWN,
    allow_reverse_collision=True,
)


# ─────────────────────────────────────────────────────────────────────────────
# Garmin trainingEffectLabel → TrainKind
# ─────────────────────────────────────────────────────────────────────────────
#
# Garmin labels are derived from aerobic + anaerobic training effect values
# and roughly correspond to our TrainKind. Keys are upper_snake_case strings
# that Garmin emits; values are the closest TrainKind we have.

GARMIN_TRAIN_MAP: Mapper[str, TrainKind] = Mapper(
    {
        "RECOVERY": TrainKind.RECOVERY,
        "BASE": TrainKind.BASE,
        "AEROBIC_BASE": TrainKind.BASE,
        "TEMPO": TrainKind.TEMPO,
        "THRESHOLD": TrainKind.THRESHOLD,
        "VO2MAX": TrainKind.VO2MAX,
        "ANAEROBIC": TrainKind.ANAEROBIC,
        "ANAEROBIC_CAPACITY": TrainKind.ANAEROBIC,
        "SPRINT": TrainKind.SPRINT,
        "LACTATE_THRESHOLD": TrainKind.THRESHOLD,
    },
    unknown=TrainKind.UNKNOWN,
    allow_reverse_collision=True,
)


# ─────────────────────────────────────────────────────────────────────────────
# Application helper (mirror of coros_sync.normalize.apply_to_detail)
# ─────────────────────────────────────────────────────────────────────────────


def apply_to_detail(detail: ActivityDetail, raw_activity: dict[str, Any]) -> None:
    """Fill `detail.sport / .train_kind / .feel` from a Garmin activity dict.

    `raw_activity` is the Garmin Connect activity-summary dict (from
    `get_activity` / `get_activities`) which carries both `activityType.typeKey`
    and `trainingEffectLabel`. Mutates detail in place.

    `detail.feel` is written on the unified 0-10 numeric scale: Garmin's raw
    post-run "feel" slider is 0-100, scaled ÷10 (so 100→10.0, 0/absent→no
    rating). Note Garmin's scale runs high=good, the opposite direction of the
    COROS adapter, even though both store the same 0-10 number.
    """
    activity_type = raw_activity.get("activityType") or {}
    type_key = activity_type.get("typeKey")
    if isinstance(type_key, str) and type_key:
        sport_norm = GARMIN_SPORT_MAP.to_normalized(type_key)
        if sport_norm is not None:
            detail.sport = sport_norm.value

    label = raw_activity.get("trainingEffectLabel")
    if isinstance(label, str) and label:
        kind = GARMIN_TRAIN_MAP.to_normalized(label)
        if kind is not None:
            detail.train_kind = kind.value

    # feel: Garmin's 0-100 slider → unified 0-10 numeric scale. 0/absent means
    # "no rating" (leave NULL), matching how models.py drops feel_type there.
    raw_feel = raw_activity.get("feel")
    if isinstance(raw_feel, (int, float)) and raw_feel > 0:
        detail.feel = raw_feel / 10
