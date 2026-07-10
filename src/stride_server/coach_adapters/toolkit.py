"""``build_stride_toolkit(user_id)`` — adapter-layer factory that materialises
a :class:`coach.runtime.toolkit.Toolkit` for one user.

Read impls hit the per-user SQLite DB + master_plan_store. Draft impls are
placeholders today (US-005); real impls land in US-007 (week) and US-009
(master).
"""

from __future__ import annotations

from dataclasses import dataclass

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
    ReplaceSessionImpl,
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
    GetWeekPlanImpl,
)


@dataclass(frozen=True)
class StrideToolkit:
    """Frozen container holding callable instances for all 26 tools."""

    # read (13)
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

    # master-scope draft (6) — placeholders until US-009
    extend_phase: ExtendPhaseImpl
    compress_phase: CompressPhaseImpl
    shift_milestone: ShiftMilestoneImpl
    change_target: ChangeTargetImpl
    propose_alternatives: ProposeAlternativesImpl
    regenerate_master: RegenerateMasterImpl


def build_stride_toolkit(user_id: str) -> Toolkit:
    """Return a :class:`StrideToolkit` (satisfying :class:`Toolkit` Protocol)
    bound to ``user_id``. The instance is cheap to construct (no I/O); each
    individual tool opens its own short-lived DB connection on call."""
    return StrideToolkit(
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
        extend_phase=ExtendPhaseImpl(user_id),
        compress_phase=CompressPhaseImpl(user_id),
        shift_milestone=ShiftMilestoneImpl(user_id),
        change_target=ChangeTargetImpl(user_id),
        propose_alternatives=ProposeAlternativesImpl(user_id),
        regenerate_master=RegenerateMasterImpl(user_id),
    )
