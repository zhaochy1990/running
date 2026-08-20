/**
 * MasterPlanAdjustPage — route adapter for /coach/master/:planId/adjust.
 *
 * Reads the stashed master-plan proposal for (user, planId). With a stash it
 * renders the review workspace; without one, the intake state. On success it
 * returns to /plan with `{ coachPlanApplied: true }` location state. Deps are
 * injectable for testing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useUser } from '../UserContextValue'
import {
  abandonCoachProposal,
  applyCoachMasterProposal,
  getMasterPlanById,
  type CoachApplyOutcome,
} from '../api'
import CoachChat from '../components/CoachChat'
import { MasterPlanAdjustWorkspace } from '../components/coach-workspace/MasterPlanAdjustWorkspace'
import { PlanAdjustIntakeWorkspace } from '../components/coach-workspace/PlanAdjustIntakeWorkspace'
import type {
  ApplyProposalRequest,
  MasterDiffProposal,
  ProposalTargetKey,
  StashedProposal,
} from '../components/coach-workspace/types'
import {
  clearStashedProposal,
  readStashedProposal,
} from '../lib/coachProposalStorage'

export interface MasterPlanAdjustPageDeps {
  readonly userId: string
  readonly planId: string
  readonly readStash: (target: ProposalTargetKey) => StashedProposal<MasterDiffProposal> | null
  readonly clearStash: (target: ProposalTargetKey) => void
  readonly apply: (
    planId: string,
    rawProposal: Readonly<Record<string, unknown>>,
    opIds: readonly string[],
    baseRevision: string,
  ) => Promise<CoachApplyOutcome>
  readonly abandon: (target: {
    kind: 'weekly' | 'master'
    folder?: string
    planId?: string
  }) => Promise<boolean | void>
  readonly navigate: (to: string, state?: unknown) => void
  readonly currentPlanSummary: string
  /** True while the current-plan summary is still loading. */
  readonly summaryLoading?: boolean
  /** Non-null when loading the master plan failed. */
  readonly summaryError?: string | null
  readonly renderChat: (contextAnchor: string) => React.ReactNode
}

/** Presentational core — pure over its injected deps. */
export function MasterPlanAdjustView({
  userId,
  planId,
  readStash,
  clearStash,
  apply,
  abandon,
  navigate,
  currentPlanSummary,
  summaryLoading = false,
  summaryError = null,
  renderChat,
}: MasterPlanAdjustPageDeps) {
  const target = useMemo<ProposalTargetKey>(
    () => ({ userId, kind: 'master', planId }),
    [userId, planId],
  )
  const stashed = useMemo(() => readStash(target), [readStash, target])
  const contextAnchor = stashed?.contextAnchor ?? ''

  const onDiscard = useCallback(() => {
    void abandon({ kind: 'master', planId })
    clearStash(target)
    navigate('/plan')
  }, [abandon, clearStash, target, navigate, planId])

  const onApplied = useCallback(() => {
    clearStash(target)
    navigate('/plan', { coachPlanApplied: true })
  }, [clearStash, target, navigate])

  const onApply = useCallback(
    (req: ApplyProposalRequest): Promise<CoachApplyOutcome> => {
      const raw = stashed?.rawProposal ?? {}
      return apply(planId, raw, req.opIds, req.baseRevision)
    },
    [apply, planId, stashed],
  )

  const summaryText = summaryLoading
    ? '加载当前赛季计划…'
    : summaryError
      ? `无法加载赛季计划：${summaryError}`
      : currentPlanSummary

  if (!stashed) {
    return (
      <PlanAdjustIntakeWorkspace
        kind="master"
        currentPlanSummary={summaryText}
        chat={renderChat(contextAnchor)}
      />
    )
  }

  return (
    <MasterPlanAdjustWorkspace
      stashed={stashed}
      currentPlanSummary={summaryText}
      onApply={onApply}
      onDiscard={onDiscard}
      onApplied={onApplied}
      chat={renderChat(contextAnchor)}
    />
  )
}

interface MasterSummaryState {
  readonly planId: string
  readonly loading: boolean
  readonly error: string | null
  readonly summary: string
}

/**
 * Load the master plan (race / period / current version) for the summary line.
 */
function useMasterSummary(planId: string): MasterSummaryState {
  const [state, setState] = useState<MasterSummaryState>(() => ({
    planId,
    loading: true,
    error: null,
    summary: '赛季训练计划',
  }))

  useEffect(() => {
    let cancelled = false
    getMasterPlanById(planId)
      .then((plan) => {
        if (cancelled) return
        const race = plan.goal?.race_name ?? '赛季目标'
        const week =
          plan.current_week_number != null && plan.total_weeks != null
            ? `第 ${plan.current_week_number}/${plan.total_weeks} 周`
            : plan.total_weeks != null
              ? `${plan.total_weeks} 周周期`
              : '周期化计划'
        const summary = `${race} · ${week} · 版本 v${plan.version}`
        setState({ planId, loading: false, error: null, summary })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : '加载失败'
        setState({ planId, loading: false, error: message, summary: '赛季训练计划' })
      })
    return () => {
      cancelled = true
    }
  }, [planId])

  if (state.planId !== planId) {
    return { planId, loading: true, error: null, summary: '赛季训练计划' }
  }
  return state
}

/** Route entry — wires the real user, params, API, router, and chat. */
export default function MasterPlanAdjustPage() {
  const { user } = useUser()
  const { planId = '' } = useParams<{ planId: string }>()
  const navigate = useNavigate()
  const { loading, error, summary } = useMasterSummary(planId)

  return (
    <MasterPlanAdjustView
      userId={user}
      planId={planId}
      readStash={(t) => readStashedProposal<MasterDiffProposal>(t)}
      clearStash={clearStashedProposal}
      apply={applyCoachMasterProposal}
      abandon={abandonCoachProposal}
      navigate={(to, state) => navigate(to, state ? { state } : undefined)}
      currentPlanSummary={summary}
      summaryLoading={loading}
      summaryError={error}
      renderChat={(anchor) => (
        <CoachChat
          contextAnchor={anchor}
          target={{ kind: 'master', plan_id: planId }}
        />
      )}
    />
  )
}
