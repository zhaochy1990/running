"""Provider-agnostic normalized enums for activity / training metadata.

These enums form the internal lingua franca: every adapter (`coros_sync`,
`garmin_sync`, …) translates its provider-specific encodings into these
values at the boundary, and the rest of stride_core / stride_server / the
frontend speaks only normalized vocabulary.

Mapping tables (e.g. COROS sport_type 100 → NormalizedSport.RUN_OUTDOOR)
live in each adapter, not here, to keep the dependency direction
adapter → core. The `Mapper` helper below is the recommended way for
adapters to declare those tables once and use them bidirectionally.

When an adapter encounters a value it has no mapping for, it should yield
the corresponding `*_UNKNOWN` value rather than raise — sync should never
crash because the watch added a new sport type we haven't catalogued yet.
The `provider_*_raw` columns on the activities table preserve the
original value for diagnostics.
"""

from __future__ import annotations

from collections.abc import Iterable
from enum import Enum
from typing import Generic, TypeVar


# ─────────────────────────────────────────────────────────────────────────────
# Sport
# ─────────────────────────────────────────────────────────────────────────────


class NormalizedSport(str, Enum):
    """Sport / activity type. String values are stable wire/storage codes."""

    # Running
    RUN_OUTDOOR  = "run_outdoor"
    RUN_INDOOR   = "run_indoor"
    RUN_TRAIL    = "run_trail"
    RUN_TRACK    = "run_track"
    RUN_TREADMILL = "run_treadmill"

    # Walking / hiking
    WALK         = "walk"
    HIKE         = "hike"

    # Cycling
    BIKE_OUTDOOR = "bike_outdoor"
    BIKE_INDOOR  = "bike_indoor"
    BIKE_GRAVEL  = "bike_gravel"
    BIKE_E       = "bike_e"

    # Swimming
    SWIM_POOL    = "swim_pool"
    SWIM_OPEN    = "swim_open"

    # Multisport
    TRIATHLON    = "triathlon"
    MULTISPORT   = "multisport"

    # Strength / fitness
    STRENGTH     = "strength"
    CARDIO       = "cardio"
    GYM          = "gym"
    HIIT         = "hiit"
    JUMP_ROPE    = "jump_rope"
    ROWING       = "rowing"

    # Snow
    SKI_DOWNHILL = "ski_downhill"
    SKI_XC       = "ski_xc"
    SKI_TOURING  = "ski_touring"
    SNOWBOARD    = "snowboard"

    # Water
    FLATWATER    = "flatwater"
    WHITEWATER   = "whitewater"
    WINDSURFING  = "windsurfing"
    SPEEDSURFING = "speedsurfing"

    # Misc
    TENNIS       = "tennis"
    GPS_CARDIO   = "gps_cardio"
    OTHER        = "other"

    # Unknown — adapter encountered a code it has no mapping for
    UNKNOWN      = "unknown"


# Sports that count as "running" for ability/training-load purposes
RUNNING_SPORTS: frozenset[NormalizedSport] = frozenset({
    NormalizedSport.RUN_OUTDOOR,
    NormalizedSport.RUN_INDOOR,
    NormalizedSport.RUN_TRAIL,
    NormalizedSport.RUN_TRACK,
    NormalizedSport.RUN_TREADMILL,
})


# ─────────────────────────────────────────────────────────────────────────────
# Train kind (workout type / intent)
# ─────────────────────────────────────────────────────────────────────────────


class TrainKind(str, Enum):
    """Intent of a training session.

    Maps from COROS `trainType` 1-8 and from heuristic inference for
    providers that don't tag this directly (e.g. Garmin).
    """

    BASE       = "base"
    AEROBIC    = "aerobic"
    THRESHOLD  = "threshold"
    INTERVAL   = "interval"
    VO2MAX     = "vo2max"
    ANAEROBIC  = "anaerobic"
    SPRINT     = "sprint"
    RECOVERY   = "recovery"
    LONG_RUN   = "long_run"      # not a COROS native value; inferred
    RACE       = "race"          # ditto
    TEMPO      = "tempo"         # ditto (subset of threshold)
    UNKNOWN    = "unknown"


# ─────────────────────────────────────────────────────────────────────────────
# Subjective effort (post-run feel)
# ─────────────────────────────────────────────────────────────────────────────


class FeelLevel(str, Enum):
    """Subjective post-run feel — from COROS feel_type 1..5 or Garmin feel."""

    EXCELLENT = "excellent"   # COROS 1
    GOOD      = "good"        # COROS 2
    NORMAL    = "normal"      # COROS 3
    BAD       = "bad"         # COROS 4
    AWFUL     = "awful"       # COROS 5
    UNKNOWN   = "unknown"


# ─────────────────────────────────────────────────────────────────────────────
# Body parts / equipment (used by exercise catalog — task #4)
# ─────────────────────────────────────────────────────────────────────────────


class BodyPart(str, Enum):
    """Major body regions targeted by a strength exercise."""

    CHEST      = "chest"
    BACK       = "back"
    SHOULDERS  = "shoulders"
    ARMS       = "arms"
    CORE       = "core"
    GLUTES     = "glutes"
    HIPS       = "hips"
    LEGS       = "legs"
    QUADS      = "quads"
    HAMSTRINGS = "hamstrings"
    CALVES     = "calves"
    FULL_BODY  = "full_body"
    MOBILITY   = "mobility"     # flexibility / mobility-focused
    UNKNOWN    = "unknown"


class Equipment(str, Enum):
    """Equipment a strength exercise requires."""

    BODYWEIGHT     = "bodyweight"
    DUMBBELL       = "dumbbell"
    BARBELL        = "barbell"
    KETTLEBELL     = "kettlebell"
    BAND           = "band"             # resistance band
    CABLE          = "cable"
    MACHINE        = "machine"
    BENCH          = "bench"
    PULL_UP_BAR    = "pull_up_bar"
    BOX            = "box"              # plyo box
    FOAM_ROLLER    = "foam_roller"
    YOGA_MAT       = "yoga_mat"
    MEDICINE_BALL  = "medicine_ball"
    BOSU           = "bosu"
    SLIDER         = "slider"
    OTHER          = "other"
    UNKNOWN        = "unknown"


# ─────────────────────────────────────────────────────────────────────────────
# Bidirectional mapper helper
# ─────────────────────────────────────────────────────────────────────────────


K = TypeVar("K")
V = TypeVar("V")


class Mapper(Generic[K, V]):
    """Bidirectional map between provider-specific keys and normalized values.

    Adapters declare a single mapping dict and get safe lookup in both
    directions, plus a configurable fallback for unknown keys/values.

        SPORT = Mapper(
            {100: NormalizedSport.RUN_OUTDOOR, 101: NormalizedSport.RUN_INDOOR, ...},
            unknown=NormalizedSport.UNKNOWN,
        )
        SPORT.to_normalized(102)        # NormalizedSport.RUN_TRAIL
        SPORT.to_normalized(99999)      # NormalizedSport.UNKNOWN
        SPORT.to_provider(NormalizedSport.RUN_OUTDOOR)   # 100

    Unlike a plain dict invert, `Mapper` rejects ambiguous reverse mappings
    at construction time (multiple provider keys → same normalized value).
    Adapters with intentional many-to-one mappings should pass
    `allow_reverse_collision=True` and use only the forward direction.
    """

    def __init__(
        self,
        forward: dict[K, V],
        *,
        unknown: V | None = None,
        allow_reverse_collision: bool = False,
    ) -> None:
        self._forward: dict[K, V] = dict(forward)
        self._unknown = unknown
        self._reverse: dict[V, K] = {}
        for key, value in self._forward.items():
            if value in self._reverse and not allow_reverse_collision:
                raise ValueError(
                    f"Reverse-mapping collision: {value!r} maps from "
                    f"both {self._reverse[value]!r} and {key!r}"
                )
            self._reverse.setdefault(value, key)

    def to_normalized(self, key: K, *, default: V | None = None) -> V | None:
        if key in self._forward:
            return self._forward[key]
        return default if default is not None else self._unknown

    def to_provider(self, value: V, *, default: K | None = None) -> K | None:
        return self._reverse.get(value, default)

    def known_provider_keys(self) -> Iterable[K]:
        return self._forward.keys()

    def known_normalized_values(self) -> Iterable[V]:
        return self._reverse.keys()

    def __contains__(self, key: K) -> bool:
        return key in self._forward
