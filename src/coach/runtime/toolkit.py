"""Toolkit Protocol — the contract every adapter must satisfy.

A ``Toolkit`` aggregates implementations of all 25 callable tools. Adapters
in ``stride_server.coach_adapters.toolkit`` produce a concrete instance,
test stubs in ``tests/coach/stubs/fake_toolkit.py`` produce a ``FakeToolkit``.

The conversation graph only ever interacts with this Protocol, never with
concrete impls — that's what keeps ``coach.*`` infrastructure-free.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from coach.tools.protocols import (
    AddStrengthSession,
    ChangePaceTarget,
    ChangeTarget,
    CompressPhase,
    ExtendPhase,
    GetAbilitySnapshot,
    GetActivityDetail,
    GetHealthSnapshot,
    GetHealthSeries,
    GetBodyCompositionLatest,
    GetMasterPlanCurrent,
    GetMasterPlanVersions,
    GetPbs,
    GetPmcSeries,
    GetRacePredictions,
    GetRecentActivities,
    GetTrainingEnvironment,
    GetWeekPlan,
    ProposeAlternatives,
    ReduceIntensity,
    RegenerateMaster,
    RegenerateWeek,
    ReplaceSession,
    ShiftMilestone,
    ShiftSession,
    SwapSessions,
)


@runtime_checkable
class Toolkit(Protocol):
    """All 25 tools surfaced as attributes for direct callable access."""

    # Read tools (12)
    get_recent_activities: GetRecentActivities
    get_health_snapshot: GetHealthSnapshot
    get_health_series: GetHealthSeries
    get_pmc_series: GetPmcSeries
    get_body_composition_latest: GetBodyCompositionLatest
    get_ability_snapshot: GetAbilitySnapshot
    get_race_predictions: GetRacePredictions
    get_pbs: GetPbs
    get_master_plan_current: GetMasterPlanCurrent
    get_master_plan_versions: GetMasterPlanVersions
    get_week_plan: GetWeekPlan
    get_activity_detail: GetActivityDetail
    get_training_environment: GetTrainingEnvironment

    # Week-scope draft tools (7)
    swap_sessions: SwapSessions
    shift_session: ShiftSession
    reduce_intensity: ReduceIntensity
    replace_session: ReplaceSession
    add_strength_session: AddStrengthSession
    change_pace_target: ChangePaceTarget
    regenerate_week: RegenerateWeek

    # Master-scope draft tools (6)
    extend_phase: ExtendPhase
    compress_phase: CompressPhase
    shift_milestone: ShiftMilestone
    change_target: ChangeTarget
    propose_alternatives: ProposeAlternatives
    regenerate_master: RegenerateMaster
