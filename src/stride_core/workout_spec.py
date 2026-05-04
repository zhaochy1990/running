"""Provider-agnostic structured workout specifications.

Workouts are authored and stored in this normalized form. Adapters translate
to provider-specific protocol payloads (COROS schedule/update entities,
Garmin Workouts API steps, etc.) at push time. The same spec can also be
stored as JSON (`scheduled_workout.spec_json`) so the local DB owns the
authoritative training calendar regardless of which watch executes it.

Design notes:

- A run workout is a flat list of `WorkoutBlock`s. Each block has a sequence
  of `WorkoutStep`s and a repeat count. Single-rep blocks express linear
  segments (warmup → tempo → cooldown). Multi-rep blocks express interval
  groups (6× [800m work + 60s recovery]).

- Each step has a `Duration` (distance, time, or open) and an optional
  `Target` (pace range, HR range, power range, or open). All durations are
  in SI base units (meters, seconds) and all paces in seconds-per-km.
  Adapter-side translation is the only place that touches provider units
  (COROS millimeters, Garmin meters, etc.).

- Strength workouts are a flat list of `StrengthExerciseSpec`s. Exercises
  reference the canonical exercise catalog by `canonical_id`; adapters look
  up their provider-specific exercise ID at push time.

- All dataclasses are frozen and JSON-roundtrippable via `to_dict()` /
  `from_dict()`. Use these (not `dataclasses.asdict`) to ensure stable
  schema with explicit `kind` discriminators.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


# ─────────────────────────────────────────────────────────────────────────────
# Enums
# ─────────────────────────────────────────────────────────────────────────────


class StepKind(str, Enum):
    """Role of a step within a workout."""

    WARMUP   = "warmup"
    WORK     = "work"        # main effort (tempo, interval rep, easy run body, …)
    RECOVERY = "recovery"    # active recovery between reps inside an interval block
    COOLDOWN = "cooldown"
    REST     = "rest"        # passive rest (e.g. between strength sets — rare in run)


class DurationKind(str, Enum):
    """How a step's length is measured."""

    DISTANCE_M = "distance_m"
    TIME_S     = "time_s"
    OPEN       = "open"      # ends manually (no fixed length)


class TargetKind(str, Enum):
    """What metric the step targets."""

    PACE_S_KM = "pace_s_km"
    HR_BPM    = "hr_bpm"
    POWER_W   = "power_w"
    OPEN      = "open"       # no specific target


class StrengthTargetKind(str, Enum):
    """What a strength exercise set targets."""

    REPS   = "reps"
    TIME_S = "time_s"


# ─────────────────────────────────────────────────────────────────────────────
# Duration / Target
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Duration:
    """How long a step lasts. `value` is None iff `kind == OPEN`."""

    kind: DurationKind
    value: float | None = None

    @classmethod
    def of_distance_m(cls, m: float) -> Duration:
        return cls(DurationKind.DISTANCE_M, float(m))

    @classmethod
    def of_distance_km(cls, km: float) -> Duration:
        return cls(DurationKind.DISTANCE_M, float(km) * 1000.0)

    @classmethod
    def of_time_s(cls, s: float) -> Duration:
        return cls(DurationKind.TIME_S, float(s))

    @classmethod
    def of_time_min(cls, minutes: float) -> Duration:
        return cls(DurationKind.TIME_S, float(minutes) * 60.0)

    @classmethod
    def open(cls) -> Duration:
        return cls(DurationKind.OPEN, None)

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind.value, "value": self.value}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Duration:
        return cls(kind=DurationKind(data["kind"]), value=data.get("value"))


@dataclass(frozen=True)
class Target:
    """Optional intensity target for a step.

    `low` / `high` form an inclusive range in the unit implied by `kind`.
    For asymmetric metrics like pace where smaller = faster, `low` is the
    slower bound (larger seconds/km) and `high` is the faster bound (smaller
    seconds/km) — the names refer to *intensity* not numeric value.
    """

    kind: TargetKind
    low: float | None = None
    high: float | None = None

    @classmethod
    def open(cls) -> Target:
        return cls(TargetKind.OPEN, None, None)

    @classmethod
    def pace_range_s_km(cls, low_s_km: float, high_s_km: float) -> Target:
        # `low` here = slower pace (larger seconds), `high` = faster pace
        slow, fast = max(low_s_km, high_s_km), min(low_s_km, high_s_km)
        return cls(TargetKind.PACE_S_KM, float(slow), float(fast))

    @classmethod
    def hr_range_bpm(cls, low: int, high: int) -> Target:
        return cls(TargetKind.HR_BPM, float(min(low, high)), float(max(low, high)))

    @classmethod
    def power_range_w(cls, low: int, high: int) -> Target:
        return cls(TargetKind.POWER_W, float(min(low, high)), float(max(low, high)))

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind.value, "low": self.low, "high": self.high}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Target:
        return cls(
            kind=TargetKind(data["kind"]),
            low=data.get("low"),
            high=data.get("high"),
        )


# ─────────────────────────────────────────────────────────────────────────────
# Step / Block / Run workout
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class WorkoutStep:
    """A single atomic step in a workout.

    `target` is the primary intensity target the runner pursues (e.g. pace
    for a tempo, HR for an easy run). `hr_cap_bpm` is a *constraint* layered
    on top: an HR ceiling that must not be crossed regardless of how the
    primary target is going. This shows up in plans like
    `4×3K @ 4:05-4:10/km, HR ≤167` — pace is the target, HR ≤167 is the
    guardrail. Encoding this explicitly avoids losing the constraint to a
    free-text note where downstream consumers (UI, intensity classifier,
    push translator) can't see it.
    """

    step_kind: StepKind
    duration: Duration
    target: Target = field(default_factory=Target.open)
    note: str | None = None
    hr_cap_bpm: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "step_kind": self.step_kind.value,
            "duration": self.duration.to_dict(),
            "target": self.target.to_dict(),
            "note": self.note,
            "hr_cap_bpm": self.hr_cap_bpm,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> WorkoutStep:
        cap = data.get("hr_cap_bpm")
        return cls(
            step_kind=StepKind(data["step_kind"]),
            duration=Duration.from_dict(data["duration"]),
            target=Target.from_dict(data["target"]),
            note=data.get("note"),
            hr_cap_bpm=int(cap) if cap is not None else None,
        )


@dataclass(frozen=True)
class WorkoutBlock:
    """A sequence of steps performed `repeat` times.

    `repeat == 1` means a linear block (e.g. a warmup or tempo segment).
    `repeat > 1` means an interval group — typically two steps (work +
    recovery) repeated N times.
    """

    steps: tuple[WorkoutStep, ...]
    repeat: int = 1

    def __post_init__(self) -> None:
        if self.repeat < 1:
            raise ValueError(f"repeat must be >= 1, got {self.repeat}")
        if not self.steps:
            raise ValueError("WorkoutBlock must have at least one step")

    def to_dict(self) -> dict[str, Any]:
        return {
            "repeat": self.repeat,
            "steps": [s.to_dict() for s in self.steps],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> WorkoutBlock:
        return cls(
            steps=tuple(WorkoutStep.from_dict(s) for s in data["steps"]),
            repeat=int(data.get("repeat", 1)),
        )


@dataclass(frozen=True)
class NormalizedRunWorkout:
    """A provider-agnostic running workout.

    Stored locally as the source of truth; adapters translate to provider
    payloads at push time. `date` is ISO YYYY-MM-DD (no timezone — workout
    days are local-calendar concepts, not instants).
    """

    name: str
    date: str                            # ISO YYYY-MM-DD
    blocks: tuple[WorkoutBlock, ...]
    note: str | None = None              # workout-level note

    def __post_init__(self) -> None:
        if not (len(self.date) == 10 and self.date[4] == "-" and self.date[7] == "-"):
            raise ValueError(f"date must be ISO YYYY-MM-DD, got {self.date!r}")
        if not self.blocks:
            raise ValueError("NormalizedRunWorkout must have at least one block")

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "run-workout/v1",
            "name": self.name,
            "date": self.date,
            "note": self.note,
            "blocks": [b.to_dict() for b in self.blocks],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> NormalizedRunWorkout:
        return cls(
            name=data["name"],
            date=data["date"],
            note=data.get("note"),
            blocks=tuple(WorkoutBlock.from_dict(b) for b in data["blocks"]),
        )


# ─────────────────────────────────────────────────────────────────────────────
# Strength
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class StrengthExerciseSpec:
    """One exercise within a strength workout.

    `canonical_id` references the canonical exercise catalog (built in a
    follow-up task). Adapters resolve this to their provider-specific
    exercise ID at push time. If the canonical_id has no provider mapping,
    the adapter may either fall back to creating a custom exercise (if its
    capabilities include CUSTOM_EXERCISE) or raise FeatureNotSupported.

    `display_name` is captured at authoring time for stable rendering even
    if the canonical catalog is later edited.
    """

    canonical_id: str
    display_name: str
    sets: int
    target_kind: StrengthTargetKind
    target_value: int
    rest_seconds: int = 60
    note: str | None = None
    # Provider-native exercise identifier authored alongside the spec.
    # For COROS this is the T-code (e.g. "T1262"). The push adapter uses
    # it to look up the catalog entry directly — bypasses name matching.
    # None means "no built-in match found at authoring time" → adapter
    # falls back to creating a custom exercise.
    provider_id: str | None = None

    def __post_init__(self) -> None:
        if self.sets < 1:
            raise ValueError(f"sets must be >= 1, got {self.sets}")
        if self.target_value < 1:
            raise ValueError(f"target_value must be >= 1, got {self.target_value}")
        if self.rest_seconds < 0:
            raise ValueError(f"rest_seconds must be >= 0, got {self.rest_seconds}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "canonical_id": self.canonical_id,
            "display_name": self.display_name,
            "sets": self.sets,
            "target_kind": self.target_kind.value,
            "target_value": self.target_value,
            "rest_seconds": self.rest_seconds,
            "note": self.note,
            "provider_id": self.provider_id,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> StrengthExerciseSpec:
        return cls(
            canonical_id=data["canonical_id"],
            display_name=data["display_name"],
            sets=int(data["sets"]),
            target_kind=StrengthTargetKind(data["target_kind"]),
            target_value=int(data["target_value"]),
            rest_seconds=int(data.get("rest_seconds", 60)),
            note=data.get("note"),
            provider_id=data.get("provider_id"),
        )


@dataclass(frozen=True)
class NormalizedStrengthWorkout:
    """A provider-agnostic strength training workout."""

    name: str
    date: str
    exercises: tuple[StrengthExerciseSpec, ...]
    note: str | None = None

    def __post_init__(self) -> None:
        if not (len(self.date) == 10 and self.date[4] == "-" and self.date[7] == "-"):
            raise ValueError(f"date must be ISO YYYY-MM-DD, got {self.date!r}")
        if not self.exercises:
            raise ValueError("NormalizedStrengthWorkout must have at least one exercise")

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "strength-workout/v1",
            "name": self.name,
            "date": self.date,
            "note": self.note,
            "exercises": [e.to_dict() for e in self.exercises],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> NormalizedStrengthWorkout:
        return cls(
            name=data["name"],
            date=data["date"],
            note=data.get("note"),
            exercises=tuple(
                StrengthExerciseSpec.from_dict(e) for e in data["exercises"]
            ),
        )


# ─────────────────────────────────────────────────────────────────────────────
# Pace string helper (authoring convenience)
# ─────────────────────────────────────────────────────────────────────────────


def parse_pace_s_km(pace: str | int | float) -> int:
    """Parse `'5:40'` or `340` into integer seconds-per-km.

    Accepts:
      - "M:SS" or "MM:SS" string (e.g. "5:40", "12:30")
      - bare number (already seconds/km)
    """
    if isinstance(pace, (int, float)):
        return int(pace)
    parts = str(pace).strip().split(":")
    if len(parts) == 1:
        return int(parts[0])
    if len(parts) == 2:
        return int(parts[0]) * 60 + int(parts[1])
    raise ValueError(f"Cannot parse pace: {pace!r}")


def format_pace_s_km(s_per_km: float | int | None) -> str | None:
    """Format integer seconds-per-km as `'M:SS/km'`. None-safe."""
    if s_per_km is None:
        return None
    total = int(round(float(s_per_km)))
    return f"{total // 60}:{total % 60:02d}/km"
