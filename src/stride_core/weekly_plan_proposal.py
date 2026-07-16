"""Typed proposal for creating a canonical weekly plan.

Unlike :class:`PlanDiff`, this proposal carries a complete ``WeeklyPlan``.  It
is used when no plan exists yet, so week-level notes and nutrition must survive
the orchestrator round trip until the user explicitly confirms the write.
"""

from __future__ import annotations

from datetime import date as date_cls, timedelta
from typing import Any

from pydantic import BaseModel, Field, model_validator

from .plan_spec import WeeklyPlan
from .timefmt import parse_week_folder_dates


def supported_weekly_plan_generation_starts(today: date_cls) -> set[date_cls]:
    """Return the only two week starts Coach may generate."""
    current = today - timedelta(days=today.weekday())
    return {current, current + timedelta(days=7)}


def is_supported_weekly_plan_generation(folder: str, *, today: date_cls) -> bool:
    """Whether ``folder`` is the Shanghai current or immediately next week."""
    bounds = parse_week_folder_dates(folder)
    if bounds is None:
        return False
    try:
        start = date_cls.fromisoformat(bounds[0])
    except ValueError:
        return False
    return start in supported_weekly_plan_generation_starts(today)


class WeeklyPlanCreateProposal(BaseModel):
    """A full weekly plan awaiting explicit user confirmation."""

    proposal_id: str
    folder: str
    plan: dict[str, Any]
    total_distance_km: float = Field(ge=0)
    ai_explanation: str
    created_at: str

    @model_validator(mode="after")
    def _validate_plan(self) -> "WeeklyPlanCreateProposal":
        plan = self.to_weekly_plan()
        if plan.week_folder != self.folder:
            raise ValueError(
                f"proposal folder {self.folder!r} does not match weekly plan "
                f"folder {plan.week_folder!r}"
            )
        bounds = parse_week_folder_dates(self.folder)
        if bounds is None:
            raise ValueError(f"invalid weekly plan folder {self.folder!r}")
        for session in plan.sessions:
            if not bounds[0] <= session.date <= bounds[1]:
                raise ValueError(
                    f"session {session.date!r} is outside weekly plan bounds"
                )
        for nutrition in plan.nutrition:
            if not bounds[0] <= nutrition.date <= bounds[1]:
                raise ValueError(
                    f"nutrition {nutrition.date!r} is outside weekly plan bounds"
                )
        return self

    def to_weekly_plan(self) -> WeeklyPlan:
        """Parse the proposal payload using the canonical domain schema."""
        return WeeklyPlan.from_dict(self.plan)
