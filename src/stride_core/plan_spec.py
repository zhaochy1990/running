"""Structured weekly training plan specifications.

Plans are authored in Markdown by the LLM (canonical source of truth) and a
parallel JSON layer is parsed *back out* of the markdown to drive calendar
views, plan-vs-actual comparisons, and one-click push to watch. This module
defines the schema for that JSON layer.

Design notes:

- A plan is **date-keyed**, not (week, day_of_week). Any session lives on a
  specific ISO `YYYY-MM-DD`. `session_index` disambiguates double-session
  days (early run + evening strength).

- A `PlannedSession` carries an optional `spec`. When `kind in {RUN,
  STRENGTH}` and `spec is not None` the session is *pushable* — the same
  `NormalizedRunWorkout` / `NormalizedStrengthWorkout` payload reused by the
  push pipeline. When `spec is None` (e.g. coach wrote "Easy 10km, pace TBD")
  the session is *aspirational*: the calendar shows the summary but the push
  button is disabled.

- Nutrition is per-day, with a flat `meals` list. We keep `items_md` as free
  text inside each meal to avoid building an ingredient catalog this round —
  only the macros are numeric.

- All dataclasses are frozen and JSON-roundtrippable via `to_dict()` /
  `from_dict()`. Schema versions are stamped explicitly so we can migrate
  without ambiguity later.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from .workout_spec import NormalizedRunWorkout, NormalizedStrengthWorkout


# ─────────────────────────────────────────────────────────────────────────────
# Enums
# ─────────────────────────────────────────────────────────────────────────────


class SessionKind(str, Enum):
    """What kind of training session this is."""

    RUN      = "run"
    STRENGTH = "strength"
    REST     = "rest"
    CROSS    = "cross"      # cross-training (cycling, swimming, etc.)
    NOTE     = "note"       # narrative-only (coach's notes for the day)


_PUSHABLE_KINDS: frozenset[SessionKind] = frozenset({SessionKind.RUN, SessionKind.STRENGTH})


def _is_iso_date(s: str) -> bool:
    return len(s) == 10 and s[4] == "-" and s[7] == "-"


# ─────────────────────────────────────────────────────────────────────────────
# Sessions
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PlannedSession:
    """One training session on a given date.

    `spec` is an instance of one of the existing normalized workout types so
    the same payload feeds the push pipeline without translation. For
    `kind=RUN`, `spec` should be `NormalizedRunWorkout`; for `kind=STRENGTH`,
    `NormalizedStrengthWorkout`. For other kinds (REST/CROSS/NOTE) it must be
    `None`.
    """

    date: str                                                                  # ISO YYYY-MM-DD
    session_index: int                                                         # 0 for the first session of the day
    kind: SessionKind
    summary: str                                                               # short user-facing label
    spec: NormalizedRunWorkout | NormalizedStrengthWorkout | None = None
    notes_md: str | None = None
    total_distance_m: float | None = None
    total_duration_s: float | None = None
    scheduled_workout_id: int | None = None                                    # FK back to scheduled_workout(id) after push

    def __post_init__(self) -> None:
        if not _is_iso_date(self.date):
            raise ValueError(f"date must be ISO YYYY-MM-DD, got {self.date!r}")
        if self.session_index < 0:
            raise ValueError(f"session_index must be >= 0, got {self.session_index}")
        if self.kind not in _PUSHABLE_KINDS and self.spec is not None:
            raise ValueError(
                f"spec must be None when kind={self.kind.value!r}, got {type(self.spec).__name__}"
            )
        if self.kind == SessionKind.RUN and self.spec is not None and not isinstance(
            self.spec, NormalizedRunWorkout
        ):
            raise ValueError(
                f"kind=run requires spec=NormalizedRunWorkout, got {type(self.spec).__name__}"
            )
        if self.kind == SessionKind.STRENGTH and self.spec is not None and not isinstance(
            self.spec, NormalizedStrengthWorkout
        ):
            raise ValueError(
                f"kind=strength requires spec=NormalizedStrengthWorkout, got {type(self.spec).__name__}"
            )

    @property
    def pushable(self) -> bool:
        """True iff this session has a complete spec the push pipeline can consume."""
        return self.kind in _PUSHABLE_KINDS and self.spec is not None

    def to_dict(self) -> dict[str, Any]:
        if self.spec is None:
            spec_payload: dict[str, Any] | None = None
        else:
            spec_payload = self.spec.to_dict()
        return {
            "schema": "plan-session/v1",
            "date": self.date,
            "session_index": self.session_index,
            "kind": self.kind.value,
            "summary": self.summary,
            "spec": spec_payload,
            "notes_md": self.notes_md,
            "total_distance_m": self.total_distance_m,
            "total_duration_s": self.total_duration_s,
            "scheduled_workout_id": self.scheduled_workout_id,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PlannedSession:
        kind = SessionKind(data["kind"])
        spec_data = data.get("spec")
        spec: NormalizedRunWorkout | NormalizedStrengthWorkout | None
        if spec_data is None:
            spec = None
        elif kind == SessionKind.RUN:
            spec = NormalizedRunWorkout.from_dict(spec_data)
        elif kind == SessionKind.STRENGTH:
            spec = NormalizedStrengthWorkout.from_dict(spec_data)
        else:
            raise ValueError(f"spec present but kind={kind.value!r} cannot carry one")
        return cls(
            date=data["date"],
            session_index=int(data["session_index"]),
            kind=kind,
            summary=data["summary"],
            spec=spec,
            notes_md=data.get("notes_md"),
            total_distance_m=data.get("total_distance_m"),
            total_duration_s=data.get("total_duration_s"),
            scheduled_workout_id=data.get("scheduled_workout_id"),
        )


# ─────────────────────────────────────────────────────────────────────────────
# Nutrition
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Meal:
    """One eating occasion. `items_md` is free-text food list."""

    name: str                              # 早餐 / 午餐 / 晚餐 / 加餐
    time_hint: str | None = None           # e.g. "7:30" — informational only
    kcal: float | None = None
    carbs_g: float | None = None
    protein_g: float | None = None
    fat_g: float | None = None
    items_md: str | None = None            # free-text: "燕麦 80g + 鸡蛋 2 个 + ..."

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "time_hint": self.time_hint,
            "kcal": self.kcal,
            "carbs_g": self.carbs_g,
            "protein_g": self.protein_g,
            "fat_g": self.fat_g,
            "items_md": self.items_md,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Meal:
        return cls(
            name=data["name"],
            time_hint=data.get("time_hint"),
            kcal=data.get("kcal"),
            carbs_g=data.get("carbs_g"),
            protein_g=data.get("protein_g"),
            fat_g=data.get("fat_g"),
            items_md=data.get("items_md"),
        )


@dataclass(frozen=True)
class PlannedNutrition:
    """Daily nutrition target plus a list of meals."""

    date: str                              # ISO YYYY-MM-DD
    kcal_target: float | None = None
    carbs_g: float | None = None
    protein_g: float | None = None
    fat_g: float | None = None
    water_ml: float | None = None
    meals: tuple[Meal, ...] = field(default_factory=tuple)
    notes_md: str | None = None

    def __post_init__(self) -> None:
        if not _is_iso_date(self.date):
            raise ValueError(f"date must be ISO YYYY-MM-DD, got {self.date!r}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "plan-nutrition/v1",
            "date": self.date,
            "kcal_target": self.kcal_target,
            "carbs_g": self.carbs_g,
            "protein_g": self.protein_g,
            "fat_g": self.fat_g,
            "water_ml": self.water_ml,
            "meals": [m.to_dict() for m in self.meals],
            "notes_md": self.notes_md,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PlannedNutrition:
        return cls(
            date=data["date"],
            kcal_target=data.get("kcal_target"),
            carbs_g=data.get("carbs_g"),
            protein_g=data.get("protein_g"),
            fat_g=data.get("fat_g"),
            water_ml=data.get("water_ml"),
            meals=tuple(Meal.from_dict(m) for m in data.get("meals", [])),
            notes_md=data.get("notes_md"),
        )


# ─────────────────────────────────────────────────────────────────────────────
# Top-level container
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class WeeklyPlan:
    """A full week's structured plan.

    Mirrors the markdown stored in `weekly_plan.content_md`. Generated by the
    LLM at plan-creation time, regenerated by the reverse parser whenever the
    markdown changes.
    """

    week_folder: str                                                           # e.g. "2026-04-20_04-26(W0)"
    sessions: tuple[PlannedSession, ...] = field(default_factory=tuple)
    nutrition: tuple[PlannedNutrition, ...] = field(default_factory=tuple)
    notes_md: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "weekly-plan/v1",
            "week_folder": self.week_folder,
            "sessions": [s.to_dict() for s in self.sessions],
            "nutrition": [n.to_dict() for n in self.nutrition],
            "notes_md": self.notes_md,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> WeeklyPlan:
        return cls(
            week_folder=data["week_folder"],
            sessions=tuple(PlannedSession.from_dict(s) for s in data.get("sessions", [])),
            nutrition=tuple(PlannedNutrition.from_dict(n) for n in data.get("nutrition", [])),
            notes_md=data.get("notes_md"),
        )
