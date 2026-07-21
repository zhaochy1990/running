/**
 * WeeklyPlanAdjustPage — route adapter for /coach/week/:folder/adjust.
 *
 * Reads the stashed proposal for (user, week folder). With a stash it renders
 * the review workspace; without one it renders the intake state (chat only, no
 * apply CTA). All side-effecting dependencies (API apply, abandon, navigation,
 * chat) are injectable so the page is testable without a router or network.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useUser } from '../UserContextValue'
import {
  abandonCoachProposal,
  applyCoachWeekProposal,
  formatWeekRange,
  getPlanDays,
  getWeek,
  type CoachApplyOutcome,
} from '../api'
import CoachChat from '../components/CoachChat'
import { clearPendingCoachTurnForWeek } from '../hooks/useCoachChat'
import { weeklyPlanStats } from '../lib/weeklyPlanView'
import { PlanAdjustIntakeWorkspace } from '../components/coach-workspace/PlanAdjustIntakeWorkspace'
import { WeeklyPlanAdjustWorkspace } from '../components/coach-workspace/WeeklyPlanAdjustWorkspace'
import type {
  ApplyProposalRequest,
  ProposalTargetKey,
  StashedProposal,
  WeeklyProposal,
} from '../components/coach-workspace/types'
import type { CoachReviewContext } from '../types/coachChat'
import {
  clearStashedProposal,
  readStashedProposal,
} from '../lib/coachProposalStorage'

export interface WeeklyPlanAdjustPageDeps {
  readonly userId: string
  readonly folder: string
  readonly readStash: (target: ProposalTargetKey) => StashedProposal<WeeklyProposal> | null
  readonly clearStash: (target: ProposalTargetKey) => void
  /** Clears a failed/in-flight Coach turn anchored to this draft. */
  readonly clearPendingTurnForWeek?: (folder: string) => void
  readonly apply: (
    folder: string,
    rawProposal: Readonly<Record<string, unknown>>,
    opIds: readonly string[],
    baseRevision: string,
    impactAck?: string,
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
  /** Non-null when loading the current plan failed (non-404). */
  readonly summaryError?: string | null
  /** True when the target week has no plan yet — invites a create instead. */
  readonly emptyTarget?: boolean
  readonly renderChat: (
    contextAnchor: string,
    reviewContext?: CoachReviewContext,
  ) => React.ReactNode
  /**
   * Opaque token that changes whenever the coach re-stashes a revised draft for
   * this same route (task #30). The Review re-reads the stash whenever it
   * changes, so a revised weekly-create proposal replaces the one on screen
   * without leaving the page. Same value across renders = no re-read.
   */
  readonly refreshToken?: string | number
}

/** Presentational core — pure over its injected deps. */
export function WeeklyPlanAdjustView({
  userId,
  folder,
  readStash,
  clearStash,
  clearPendingTurnForWeek,
  apply,
  abandon,
  navigate,
  currentPlanSummary,
  summaryLoading = false,
  summaryError = null,
  emptyTarget = false,
  renderChat,
  refreshToken,
}: WeeklyPlanAdjustPageDeps) {
  const target = useMemo<ProposalTargetKey>(
    () => ({ userId, kind: 'weekly', folder }),
    [userId, folder],
  )
  // `refreshToken` is an intentional extra dep: when the coach re-stashes a
  // revised draft for this same route, the token changes and the stash is
  // re-read, swapping the on-screen Review for the revision. eslint can't see
  // that readStash reads external (sessionStorage) state keyed only by target.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stashed = useMemo(() => readStash(target), [readStash, target, refreshToken])
  const contextAnchor = stashed?.contextAnchor ?? ''

  // A not-yet-applied weekly-create draft anchors the chat so a follow-up like
  // "这个课表的训练逻辑是什么" is answered from the draft, not a saved plan. Only
  // weekly_create carries a full plan; a diff proposal has nothing to explain
  // from a draft, so it sends no review context (ordinary chat).
  const reviewContext = useMemo<CoachReviewContext | undefined>(() => {
    if (!stashed || stashed.proposal.proposalType !== 'weekly_create') return undefined
    const raw = stashed.rawProposal
    if (typeof raw.folder !== 'string' || raw.folder !== folder) return undefined
    return { kind: 'weekly_create', proposal: raw }
  }, [stashed, folder])

  const backToWeek = useCallback(() => {
    navigate(`/week/${encodeURIComponent(folder)}`)
  }, [navigate, folder])

  const onDiscard = useCallback(() => {
    void abandon({ kind: 'weekly', folder })
    clearPendingTurnForWeek?.(folder)
    clearStash(target)
    backToWeek()
  }, [abandon, clearPendingTurnForWeek, clearStash, target, backToWeek, folder])

  const onApplied = useCallback(() => {
    clearPendingTurnForWeek?.(folder)
    clearStash(target)
    navigate(`/week/${encodeURIComponent(folder)}`, { coachPlanApplied: true })
  }, [clearPendingTurnForWeek, clearStash, target, navigate, folder])

  const onApply = useCallback(
    (req: ApplyProposalRequest): Promise<CoachApplyOutcome> => {
      const raw = stashed?.rawProposal ?? {}
      return apply(folder, raw, req.opIds, req.baseRevision, req.impactAcknowledgement)
    },
    [apply, folder, stashed],
  )

  const summaryText = summaryLoading
    ? '加载当前计划…'
    : summaryError
      ? `无法加载当前计划：${summaryError}`
      : currentPlanSummary

  if (!stashed) {
    return (
      <PlanAdjustIntakeWorkspace
        kind="weekly"
        currentPlanSummary={summaryText}
        emptyTarget={emptyTarget}
        chat={renderChat(contextAnchor)}
      />
    )
  }

  return (
    <WeeklyPlanAdjustWorkspace
      stashed={stashed}
      currentPlanSummary={summaryText}
      onApply={onApply}
      onDiscard={onDiscard}
      onApplied={onApplied}
      chat={renderChat(contextAnchor, reviewContext)}
    />
  )
}

interface WeekSummaryState {
  readonly requestKey: string
  readonly loading: boolean
  readonly error: string | null
  readonly emptyTarget: boolean
  readonly summary: string
}

/** Extract the HTTP status embedded in `fetchJSON`'s "API error: {status}" message. */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes('404')
}

/**
 * Load the current week (date range + planned run km / session count) for the
 * summary. A 404 means the week has no plan yet -> emptyTarget (create prompt);
 * any other failure is surfaced as an error.
 */
function useWeekSummary(user: string, folder: string): WeekSummaryState {
  const requestKey = `${user}:${folder}`
  const [state, setState] = useState<WeekSummaryState>(() => ({
    requestKey,
    loading: true,
    error: null,
    emptyTarget: false,
    summary: `本周课表 · ${folder}`,
  }))

  useEffect(() => {
    let cancelled = false
    getWeek(user, folder)
      .then(async (week) => {
        if (cancelled) return
        const range = formatWeekRange(week.date_from, week.date_to)
        let plannedRunKm = 0
        let sessionCount = 0
        try {
          const { days } = await getPlanDays(user, week.date_from, week.date_to)
          const stats = weeklyPlanStats(days)
          plannedRunKm = stats.plannedRunKm
          sessionCount = stats.sessions.length
        } catch {
          /* plan days optional — fall back to the range-only summary */
        }
        if (cancelled) return
        const summary = `${range} · 计划跑量 ${plannedRunKm.toFixed(1)} km · ${sessionCount} 训练课`
        setState({ requestKey, loading: false, error: null, emptyTarget: false, summary })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (isNotFound(error)) {
          setState({
            requestKey,
            loading: false,
            error: null,
            emptyTarget: true,
            summary: `本周课表 · ${folder}`,
          })
        } else {
          const message = error instanceof Error ? error.message : '加载失败'
          setState({
            requestKey,
            loading: false,
            error: message,
            emptyTarget: false,
            summary: `本周课表 · ${folder}`,
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [user, folder, requestKey])

  if (state.requestKey !== requestKey) {
    return {
      requestKey,
      loading: true,
      error: null,
      emptyTarget: false,
      summary: `本周课表 · ${folder}`,
    }
  }
  return state
}

/** Route entry — wires the real user, params, API, router, and chat. */
export default function WeeklyPlanAdjustPage() {
  const { user } = useUser()
  const { folder = '' } = useParams<{ folder: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { loading, error, emptyTarget, summary } = useWeekSummary(user, folder)

  // A same-route navigation that re-stashes a revised draft carries a changing
  // `draftRevision` marker in history state (task #30). Feed it in as the
  // refresh token so the Review re-reads the freshly-stashed revision without
  // leaving the page. Any location-state shape is tolerated (external input).
  const refreshToken =
    typeof location.state === 'object' && location.state !== null
      ? (location.state as { draftRevision?: string | number }).draftRevision
      : undefined

  return (
    <WeeklyPlanAdjustView
      userId={user}
      folder={folder}
      readStash={(t) => readStashedProposal<WeeklyProposal>(t)}
      clearStash={clearStashedProposal}
      clearPendingTurnForWeek={clearPendingCoachTurnForWeek}
      apply={applyCoachWeekProposal}
      abandon={abandonCoachProposal}
      navigate={(to, state) => navigate(to, state ? { state } : undefined)}
      currentPlanSummary={summary}
      summaryLoading={loading}
      summaryError={error}
      emptyTarget={emptyTarget}
      refreshToken={refreshToken}
      renderChat={(anchor, reviewContext) => (
        <CoachChat
          contextAnchor={anchor}
          target={{ kind: 'week', folder }}
          reviewContext={reviewContext}
        />
      )}
    />
  )
}
