"""Canonical structured weekly-plan storage contract."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from stride_core.plan_spec import WeeklyPlan


@runtime_checkable
class WeeklyPlanStore(Protocol):
    """Current ``WeeklyPlan`` state, uniquely keyed by its week-start date."""

    def save_plan(
        self, user_id: str, plan: WeeklyPlan, *, generated_by: str | None = None,
        source_hash: str | None = None,
    ) -> None: ...

    def create_plan(
        self, user_id: str, plan: WeeklyPlan, *, generated_by: str | None = None,
        source_hash: str | None = None,
    ) -> bool:
        """Create only when the Shanghai week does not exist."""
        ...

    def get_plan(self, user_id: str, folder: str) -> WeeklyPlan | None: ...

    def get_generated_by(self, user_id: str, folder: str) -> str | None: ...

    def get_source_hash(self, user_id: str, folder: str) -> str | None: ...

    def get_current_plan(self, user_id: str, on_date: str) -> WeeklyPlan | None: ...

    def list_plans(self, user_id: str) -> list[WeeklyPlan]: ...

    def delete_user(self, user_id: str) -> int: ...
