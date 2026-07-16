"""``build_stride_toolkit(user_id)`` — adapter-layer factory that materialises
a :class:`coach.runtime.toolkit.Toolkit` for one user.

Read impls hit the per-user SQLite DB + master_plan_store. Draft impls emit
typed diffs and never apply them.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from coach.runtime.toolkit import Toolkit

from .tool_impls.draft_impls import (
    AddStrengthSessionImpl,
    ChangePaceTargetImpl,
    ChangeTargetImpl,
    CompressPhaseImpl,
    ExtendPhaseImpl,
    ProposeAlternativesImpl,
    ReduceIntensityImpl,
    RegenerateMasterImpl,
    RegenerateWeekImpl,
    RescheduleTargetRaceImpl,
    ReplaceSessionImpl,
    SetPhaseWeeklyRangeImpl,
    ShiftMilestoneImpl,
    ShiftSessionImpl,
    SwapSessionsImpl,
)
from .tool_impls.read_impls import (
    EstimateMasterPlanLoadImpl,
    GetAbilitySnapshotImpl,
    GetActivityDetailImpl,
    GetBodyCompositionLatestImpl,
    GetHealthSnapshotImpl,
    GetMasterPlanCurrentImpl,
    GetMasterPlanVersionsImpl,
    GetPbsImpl,
    GetPmcSeriesImpl,
    GetRacePredictionsImpl,
    GetHealthSeriesImpl,
    GetRecentActivitiesImpl,
    GetTrainingEnvironmentImpl,
    GetTrainingSummaryImpl,
    GetWeekPlanImpl,
)


@dataclass(frozen=True)
class StrideToolkit:
    """Frozen container holding callable instances for all 30 tools."""

    # read (15)
    get_training_summary: GetTrainingSummaryImpl
    get_recent_activities: GetRecentActivitiesImpl
    get_health_snapshot: GetHealthSnapshotImpl
    get_health_series: GetHealthSeriesImpl
    get_pmc_series: GetPmcSeriesImpl
    get_body_composition_latest: GetBodyCompositionLatestImpl
    get_ability_snapshot: GetAbilitySnapshotImpl
    get_race_predictions: GetRacePredictionsImpl
    get_pbs: GetPbsImpl
    get_master_plan_current: GetMasterPlanCurrentImpl
    get_master_plan_versions: GetMasterPlanVersionsImpl
    get_week_plan: GetWeekPlanImpl
    get_activity_detail: GetActivityDetailImpl
    get_training_environment: GetTrainingEnvironmentImpl
    estimate_master_plan_load: EstimateMasterPlanLoadImpl

    # week-scope draft (7) — placeholders until US-007
    swap_sessions: SwapSessionsImpl
    shift_session: ShiftSessionImpl
    reduce_intensity: ReduceIntensityImpl
    replace_session: ReplaceSessionImpl
    add_strength_session: AddStrengthSessionImpl
    change_pace_target: ChangePaceTargetImpl
    regenerate_week: RegenerateWeekImpl

    # master-scope draft (8)
    extend_phase: ExtendPhaseImpl
    compress_phase: CompressPhaseImpl
    shift_milestone: ShiftMilestoneImpl
    reschedule_target_race: RescheduleTargetRaceImpl
    change_target: ChangeTargetImpl
    set_phase_weekly_range: SetPhaseWeeklyRangeImpl
    propose_alternatives: ProposeAlternativesImpl
    regenerate_master: RegenerateMasterImpl


def build_stride_toolkit(
    user_id: str, *, master_plan_loader: Callable[[str], Any] | None = None
) -> Toolkit:
    """Return a :class:`StrideToolkit` (satisfying :class:`Toolkit` Protocol)
    bound to ``user_id``. The instance is cheap to construct (no I/O); each
    individual tool opens its own short-lived DB connection on call."""
    return StrideToolkit(
        get_training_summary=GetTrainingSummaryImpl(user_id),
        get_recent_activities=GetRecentActivitiesImpl(user_id),
        get_health_snapshot=GetHealthSnapshotImpl(user_id),
        get_health_series=GetHealthSeriesImpl(user_id),
        get_pmc_series=GetPmcSeriesImpl(user_id),
        get_body_composition_latest=GetBodyCompositionLatestImpl(user_id),
        get_ability_snapshot=GetAbilitySnapshotImpl(user_id),
        get_race_predictions=GetRacePredictionsImpl(user_id),
        get_pbs=GetPbsImpl(user_id),
        get_master_plan_current=GetMasterPlanCurrentImpl(user_id),
        get_master_plan_versions=GetMasterPlanVersionsImpl(user_id),
        get_week_plan=GetWeekPlanImpl(user_id),
        get_activity_detail=GetActivityDetailImpl(user_id),
        get_training_environment=GetTrainingEnvironmentImpl(user_id),
        estimate_master_plan_load=EstimateMasterPlanLoadImpl(user_id),
        swap_sessions=SwapSessionsImpl(user_id),
        shift_session=ShiftSessionImpl(user_id),
        reduce_intensity=ReduceIntensityImpl(user_id),
        replace_session=ReplaceSessionImpl(user_id),
        add_strength_session=AddStrengthSessionImpl(user_id),
        change_pace_target=ChangePaceTargetImpl(user_id),
        regenerate_week=RegenerateWeekImpl(user_id),
        extend_phase=ExtendPhaseImpl(user_id, plan_loader=master_plan_loader),
        compress_phase=CompressPhaseImpl(user_id, plan_loader=master_plan_loader),
        shift_milestone=ShiftMilestoneImpl(user_id, plan_loader=master_plan_loader),
        reschedule_target_race=RescheduleTargetRaceImpl(
            user_id, plan_loader=master_plan_loader
        ),
        change_target=ChangeTargetImpl(user_id, plan_loader=master_plan_loader),
        set_phase_weekly_range=SetPhaseWeeklyRangeImpl(
            user_id, plan_loader=master_plan_loader
        ),
        propose_alternatives=ProposeAlternativesImpl(
            user_id, plan_loader=master_plan_loader
        ),
        regenerate_master=RegenerateMasterImpl(user_id, plan_loader=master_plan_loader),
    )
