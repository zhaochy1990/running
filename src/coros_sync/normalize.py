"""COROS-specific encoding ↔ stride_core normalized enums.

Mapping tables live here (in the adapter), not in `stride_core/normalize.py`,
to keep the dependency direction adapter → core. The provider-specific
quirks (e.g. COROS using both `402` and `800` for strength) are isolated
from the rest of the system.

Usage from the COROS sync path:

    detail = ActivityDetail.from_api(raw_detail_data, label_id)
    apply_to_detail(detail, raw_detail_data)
    db.upsert_activity(detail, provider='coros')

`apply_to_detail` mutates the dataclass in-place — the post-from_api hook
is the one place that translates COROS-specific encodings (sport_type int,
trainType int, feelType int) into the provider-agnostic enum values that
stride_core / stride_server / the frontend speak.
"""

from __future__ import annotations

from typing import Any

from stride_core.models import ActivityDetail
from stride_core.normalize import (
    FeelLevel,
    Mapper,
    NormalizedSport,
    TrainKind,
)


# ─────────────────────────────────────────────────────────────────────────────
# COROS sport_type → NormalizedSport
# ─────────────────────────────────────────────────────────────────────────────
#
# `allow_reverse_collision=True` because COROS has historically used both
# 402 ("Strength Training") and 800 ("Strength") for the same activity type;
# the forward map is well-defined, only the inverse is ambiguous (and we
# never use the inverse for sport).

COROS_SPORT_MAP: Mapper[int, NormalizedSport] = Mapper(
    {
        # Running family
        100: NormalizedSport.RUN_OUTDOOR,
        101: NormalizedSport.RUN_INDOOR,
        102: NormalizedSport.RUN_TRAIL,
        103: NormalizedSport.RUN_TRACK,
        104: NormalizedSport.RUN_TREADMILL,
        # Cycling
        200: NormalizedSport.BIKE_OUTDOOR,
        201: NormalizedSport.BIKE_INDOOR,
        202: NormalizedSport.BIKE_E,
        203: NormalizedSport.BIKE_GRAVEL,
        # Swimming
        300: NormalizedSport.SWIM_POOL,
        301: NormalizedSport.SWIM_OPEN,
        # Multisport
        400: NormalizedSport.TRIATHLON,
        401: NormalizedSport.MULTISPORT,
        402: NormalizedSport.STRENGTH,
        # Gym / cardio
        500: NormalizedSport.CARDIO,
        501: NormalizedSport.GYM,
        502: NormalizedSport.HIIT,
        503: NormalizedSport.JUMP_ROPE,
        504: NormalizedSport.ROWING,
        # Walking / hiking
        600: NormalizedSport.WALK,
        601: NormalizedSport.HIKE,
        # Snow
        700: NormalizedSport.SKI_DOWNHILL,
        701: NormalizedSport.SNOWBOARD,
        702: NormalizedSport.SKI_XC,
        703: NormalizedSport.SKI_TOURING,
        # Strength (alternate code)
        800: NormalizedSport.STRENGTH,
        # Misc
        1005: NormalizedSport.TENNIS,
        10000: NormalizedSport.GPS_CARDIO,
        10001: NormalizedSport.FLATWATER,
        10002: NormalizedSport.WHITEWATER,
        10003: NormalizedSport.WINDSURFING,
        10004: NormalizedSport.SPEEDSURFING,
    },
    unknown=NormalizedSport.UNKNOWN,
    allow_reverse_collision=True,
)

# ─────────────────────────────────────────────────────────────────────────────
# COROS trainType → TrainKind
# ─────────────────────────────────────────────────────────────────────────────
#
# COROS exposes `trainType` as an int 1-8 in the activity detail summary.
# Inferred kinds (TEMPO, LONG_RUN, RACE) have no COROS code — we never write
# them via this map; they're emitted by adapters that do post-hoc inference.

COROS_TRAIN_MAP: Mapper[int, TrainKind] = Mapper(
    {
        1: TrainKind.BASE,
        2: TrainKind.AEROBIC,
        3: TrainKind.THRESHOLD,
        4: TrainKind.INTERVAL,
        5: TrainKind.VO2MAX,
        6: TrainKind.ANAEROBIC,
        7: TrainKind.SPRINT,
        8: TrainKind.RECOVERY,
    },
    unknown=TrainKind.UNKNOWN,
)

# ─────────────────────────────────────────────────────────────────────────────
# COROS feelType (1-5) → FeelLevel
# ─────────────────────────────────────────────────────────────────────────────
#
# COROS `feelType` is the post-run face emoji rating: 1=很好 → 5=很差. Mirror
# the FeelLevel enum order.

COROS_FEEL_MAP: Mapper[int, FeelLevel] = Mapper(
    {
        1: FeelLevel.EXCELLENT,
        2: FeelLevel.GOOD,
        3: FeelLevel.NORMAL,
        4: FeelLevel.BAD,
        5: FeelLevel.AWFUL,
    },
    unknown=FeelLevel.UNKNOWN,
)


# ─────────────────────────────────────────────────────────────────────────────
# Application helper
# ─────────────────────────────────────────────────────────────────────────────


def apply_to_detail(detail: ActivityDetail, raw_data: dict[str, Any]) -> None:
    """Fill `detail.sport / .train_kind / .feel` from COROS-encoded values.

    Mutates `detail` in-place. Safe to call multiple times (idempotent).

    `raw_data` is the original `/activity/detail/query` response dict;
    we need it because `ActivityDetail.from_api` already converts COROS's
    int `trainType` to a localized name string ("Aerobic Endurance"),
    discarding the int. We re-read it from the raw payload.

    Provider-agnostic fields written:
      - `detail.sport`       → NormalizedSport.value (str), e.g. "run_outdoor"
      - `detail.train_kind`  → TrainKind.value (str),       e.g. "interval"
      - `detail.feel`        → FeelLevel.value (str),       e.g. "good"

    Original COROS columns (`sport_type` int, `train_type` localized str,
    `feel_type` int) are left untouched so existing readers (ability.py,
    legacy frontend code) keep working until they're migrated.
    """
    summary = raw_data.get("data", {}).get("summary", {}) or {}

    # sport: always populated (COROS_SPORT_MAP has unknown=UNKNOWN fallback)
    if detail.sport_type is not None:
        sport_norm = COROS_SPORT_MAP.to_normalized(detail.sport_type)
        if sport_norm is not None:
            detail.sport = sport_norm.value

    # train_kind: only when COROS gave us a trainType code
    train_type_id = summary.get("trainType")
    if train_type_id:
        kind = COROS_TRAIN_MAP.to_normalized(train_type_id)
        if kind is not None:
            detail.train_kind = kind.value

    # feel: only when the user actually rated the run
    if detail.feel_type:
        feel_norm = COROS_FEEL_MAP.to_normalized(detail.feel_type)
        if feel_norm is not None:
            detail.feel = feel_norm.value
