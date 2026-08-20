/**
 * Public surface of the plan-adjust workspace slice. The main thread wires a
 * thin adapter from the real coach API to these components + the sessionStorage
 * stash, mounting them at the canonical routes:
 *
 *   /coach/week/:folder/adjust    -> WeeklyPlanAdjustWorkspace
 *   /coach/master/:planId/adjust  -> MasterPlanAdjustWorkspace
 */
export { WeeklyPlanAdjustWorkspace } from './WeeklyPlanAdjustWorkspace'
export { MasterPlanAdjustWorkspace } from './MasterPlanAdjustWorkspace'
export { PlanAdjustIntakeWorkspace } from './PlanAdjustIntakeWorkspace'
export { WorkspaceLayout } from './WorkspaceLayout'
export { DiffReview } from './DiffReview'
export { CreateReview } from './CreateReview'
export type {
  ApplyOutcome,
  ApplyProposalRequest,
  CreatePlanDay,
  DiffChange,
  MasterDiffProposal,
  PlanTargetKind,
  ProposalTargetKey,
  SeasonImpactLevel,
  SeasonImpactProjection,
  StashedProposal,
  WeeklyCreateProposal,
  WeeklyDiffProposal,
  WeeklyProposal,
  WorkspaceProposal,
} from './types'
