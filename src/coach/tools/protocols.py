"""Callable Protocols for every coach tool — see plan §5.

Tools come in two flavours:

* **Read tools (11)** — pull data out of STRIDE state. They are safe to call
  any time and their ``ToolResult.data`` contains the read payload.

* **Draft tools (13)** — emit a proposed change. They never apply it. Their
  ``ToolResult.data`` is the serialised form of a typed diff:
  - 7 week-scope draft tools → ``stride_core.plan_diff.PlanDiff`` shape
  - 6 master-scope draft tools → ``stride_core.master_plan_diff.MasterPlanDiff`` shape

There are intentionally **no execute tools**: every side effect (push to
watch, apply diff, sync, etc.) is triggered by a deterministic UI chip
calling a server endpoint, not by the agent. See plan §1.3 + §5.3.

Each tool is a ``Protocol`` with ``__call__`` so impls can be plain functions
or classes implementing ``__call__``. All tools return :class:`ToolResult`.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from coach.schemas import ToolResult


# ─────────────────────────────────────────────────────────────────────────────
# Read tools (11)
# ─────────────────────────────────────────────────────────────────────────────


@runtime_checkable
class GetRecentActivities(Protocol):
    def __call__(self, *, limit: int = 14) -> ToolResult: ...


@runtime_checkable
class GetHealthSnapshot(Protocol):
    def __call__(self) -> ToolResult: ...


@runtime_checkable
class GetPmcSeries(Protocol):
    def __call__(self, *, days: int = 42, granularity: str = "daily") -> ToolResult: ...


@runtime_checkable
class GetBodyCompositionLatest(Protocol):
    def __call__(self) -> ToolResult: ...


@runtime_checkable
class GetAbilitySnapshot(Protocol):
    def __call__(self) -> ToolResult: ...


@runtime_checkable
class GetRacePredictions(Protocol):
    def __call__(self) -> ToolResult: ...


@runtime_checkable
class GetPbs(Protocol):
    def __call__(self) -> ToolResult: ...


@runtime_checkable
class GetMasterPlanCurrent(Protocol):
    def __call__(self) -> ToolResult: ...


@runtime_checkable
class GetMasterPlanVersions(Protocol):
    def __call__(self, *, plan_id: str) -> ToolResult: ...


@runtime_checkable
class GetWeekPlan(Protocol):
    def __call__(self, *, folder: str) -> ToolResult: ...


@runtime_checkable
class GetActivityDetail(Protocol):
    def __call__(self, *, label_id: str) -> ToolResult: ...


# ─────────────────────────────────────────────────────────────────────────────
# Week-scope draft tools (7) — ToolResult.data = PlanDiff.model_dump()
# ─────────────────────────────────────────────────────────────────────────────


@runtime_checkable
class SwapSessions(Protocol):
    def __call__(self, *, folder: str, date_a: str, date_b: str) -> ToolResult: ...


@runtime_checkable
class ShiftSession(Protocol):
    def __call__(self, *, folder: str, date: str, to_date: str, session_index: int = 0) -> ToolResult: ...


@runtime_checkable
class ReduceIntensity(Protocol):
    def __call__(self, *, folder: str, scope: str, factor: float, reason: str) -> ToolResult: ...


@runtime_checkable
class ReplaceSession(Protocol):
    def __call__(self, *, folder: str, date: str, session_index: int, new_kind: str, params: dict) -> ToolResult: ...


@runtime_checkable
class AddStrengthSession(Protocol):
    def __call__(self, *, folder: str, date: str, focus: str) -> ToolResult: ...


@runtime_checkable
class ChangePaceTarget(Protocol):
    def __call__(self, *, folder: str, date: str, session_index: int, new_pace_s_per_km: int) -> ToolResult: ...


@runtime_checkable
class RegenerateWeek(Protocol):
    def __call__(self, *, folder: str, reason: str, constraints: list[str]) -> ToolResult: ...


# ─────────────────────────────────────────────────────────────────────────────
# Master-scope draft tools (6) — ToolResult.data = MasterPlanDiff.model_dump()
# ─────────────────────────────────────────────────────────────────────────────


@runtime_checkable
class ExtendPhase(Protocol):
    def __call__(self, *, plan_id: str, phase_id: str, weeks: int) -> ToolResult: ...


@runtime_checkable
class CompressPhase(Protocol):
    def __call__(self, *, plan_id: str, phase_id: str, weeks: int) -> ToolResult: ...


@runtime_checkable
class ShiftMilestone(Protocol):
    def __call__(self, *, plan_id: str, milestone_id: str, new_date: str) -> ToolResult: ...


@runtime_checkable
class ChangeTarget(Protocol):
    def __call__(self, *, plan_id: str, milestone_id: str, new_target_time: str) -> ToolResult: ...


@runtime_checkable
class ProposeAlternatives(Protocol):
    def __call__(self, *, plan_id: str, intent: str) -> ToolResult: ...


@runtime_checkable
class RegenerateMaster(Protocol):
    def __call__(self, *, plan_id: str, reason: str) -> ToolResult: ...


# ─────────────────────────────────────────────────────────────────────────────
# Convenience name lists (graph wiring uses these to bind_tools per scope)
# ─────────────────────────────────────────────────────────────────────────────


READ_TOOL_NAMES: tuple[str, ...] = (
    "get_recent_activities",
    "get_health_snapshot",
    "get_pmc_series",
    "get_body_composition_latest",
    "get_ability_snapshot",
    "get_race_predictions",
    "get_pbs",
    "get_master_plan_current",
    "get_master_plan_versions",
    "get_week_plan",
    "get_activity_detail",
)

WEEK_DRAFT_TOOL_NAMES: tuple[str, ...] = (
    "swap_sessions",
    "shift_session",
    "reduce_intensity",
    "replace_session",
    "add_strength_session",
    "change_pace_target",
    "regenerate_week",
)

MASTER_DRAFT_TOOL_NAMES: tuple[str, ...] = (
    "extend_phase",
    "compress_phase",
    "shift_milestone",
    "change_target",
    "propose_alternatives",
    "regenerate_master",
)

ALL_TOOL_NAMES: tuple[str, ...] = (
    READ_TOOL_NAMES + WEEK_DRAFT_TOOL_NAMES + MASTER_DRAFT_TOOL_NAMES
)
