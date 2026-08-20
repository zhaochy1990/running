import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { CreateReview } from './CreateReview'
import { DiffReview } from './DiffReview'
import { WorkspaceLayout } from './WorkspaceLayout'
import type {
  ApplyOutcome,
  ApplyProposalRequest,
  StashedProposal,
  WeeklyProposal,
} from './types'

interface WeeklyPlanAdjustWorkspaceProps {
  readonly stashed: StashedProposal<WeeklyProposal>
  /** One-line summary of the current plan, shown above the proposal. */
  readonly currentPlanSummary: string
  /** Applies the whole proposal. Returns a discriminated outcome (ok/stale/error). */
  readonly onApply: (req: ApplyProposalRequest) => Promise<ApplyOutcome>
  /** Clears the stashed proposal + context anchor and returns to the target plan. */
  readonly onDiscard: () => void
  /** Injected coach chat panel (right column). */
  readonly chat: ReactNode
  /** Called after a successful apply. */
  readonly onApplied?: () => void
}

/** The acknowledgement token sent when the user opts to keep the change week-only. */
const WEEK_ONLY_ACK = 'weekly_only'

type ApplyState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'applying' }
  | { readonly phase: 'stale' }
  | { readonly phase: 'error'; readonly message: string }

/**
 * Middle+right columns of the weekly plan-adjust workspace. Renders the current
 * plan, a single full proposal Review, and applies it as one unit. When the
 * proposal carries a material season impact, apply is blocked until the user
 * explicitly chooses to keep the change week-only.
 */
export function WeeklyPlanAdjustWorkspace({
  stashed,
  currentPlanSummary,
  onApply,
  onDiscard,
  chat,
  onApplied,
}: WeeklyPlanAdjustWorkspaceProps) {
  const { proposal } = stashed
  const [applyState, setApplyState] = useState<ApplyState>({ phase: 'idle' })
  const [acknowledged, setAcknowledged] = useState(false)
  /** Material impact surfaced by the server (409 needs_ack) after apply. */
  const [serverImpact, setServerImpact] = useState<string | null>(null)

  const isDiff = proposal.proposalType === 'weekly_diff'
  const projectedImpact = isDiff ? proposal.seasonImpact ?? null : null
  /** Non-blocking advisory notice, shown but never gating apply. */
  const advisoryImpact =
    isDiff && proposal.seasonImpactProjection?.level === 'advisory'
      ? proposal.seasonImpactProjection.reasons.join('；')
      : null
  const materialImpactText = projectedImpact ?? serverImpact
  const hasMaterialImpact = Boolean(materialImpactText)

  const opIds = useMemo<readonly string[]>(() => {
    if (proposal.proposalType === 'weekly_create') return proposal.opIds
    return proposal.changes.map((c) => c.opId)
  }, [proposal])

  const applyBlocked =
    applyState.phase === 'applying' || (hasMaterialImpact && !acknowledged)

  async function handleApply(): Promise<void> {
    if (applyBlocked) return
    setApplyState({ phase: 'applying' })
    const req: ApplyProposalRequest = {
      opIds,
      baseRevision: proposal.baseRevision,
      ...(hasMaterialImpact ? { impactAcknowledgement: WEEK_ONLY_ACK } : {}),
    }
    try {
      const outcome = await onApply(req)
      if (outcome.status === 'ok') {
        setApplyState({ phase: 'idle' })
        onApplied?.()
      } else if (outcome.status === 'stale') {
        setApplyState({ phase: 'stale' })
      } else if (outcome.status === 'needs_ack') {
        // Server found a material impact the projection missed — reveal the
        // confirmation gate instead of erroring out.
        setServerImpact(outcome.seasonImpact)
        setApplyState({ phase: 'idle' })
      } else {
        setApplyState({ phase: 'error', message: outcome.message })
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '启用失败，请重试'
      setApplyState({ phase: 'error', message })
    }
  }

  return (
    <WorkspaceLayout title="调整训练周" chat={chat}>
      <section className="space-y-4">
        <div className="rounded-lg border border-border-subtle bg-bg-card p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-text-muted">
            当前计划
          </div>
          <div className="mt-1 text-sm text-text-primary">{currentPlanSummary}</div>
        </div>

        <div className="rounded-lg border border-border-subtle bg-bg-card p-4">
          {proposal.proposalType !== 'weekly_create' && (
            <div className="mb-3 text-sm font-medium text-text-primary">
              {proposal.summary}
            </div>
          )}

          {proposal.proposalType === 'weekly_create' ? (
            <CreateReview
              days={proposal.days}
              strength={proposal.strength}
              nutrition={proposal.nutrition}
              notesMd={proposal.notesMd}
            />
          ) : (
            <DiffReview changes={proposal.changes} />
          )}

          {advisoryImpact && !hasMaterialImpact && (
            <div className="mt-4 rounded-lg border border-accent-amber/40 bg-amber-soft p-3 text-sm text-text-muted">
              {advisoryImpact}
            </div>
          )}

          {hasMaterialImpact && (
            <fieldset className="mt-4 rounded-lg border border-accent-amber/40 bg-amber-soft p-3">
              <legend className="px-1 text-sm font-medium text-text-primary">
                这个改动会影响后续赛季
              </legend>
              <p className="mb-3 text-sm text-text-muted">{materialImpactText}</p>
              <label className="flex items-start gap-2 text-sm text-text-primary">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>仍只调整本周（不改动整体赛季计划）</span>
              </label>
            </fieldset>
          )}
        </div>

        {applyState.phase === 'stale' && (
          <div
            role="alert"
            className="rounded-lg border border-accent-red/30 bg-red-soft p-3 text-sm text-accent-red"
          >
            <p>方案已过期：计划在生成方案后发生了变化。</p>
            <button
              type="button"
              className="mt-2 rounded-lg border border-accent-red/40 px-3 py-1.5 text-sm font-medium text-accent-red focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-red"
              onClick={onDiscard}
            >
              重新生成方案
            </button>
          </div>
        )}

        {applyState.phase === 'error' && (
          <div
            role="alert"
            className="rounded-lg border border-accent-red/30 bg-red-soft p-3 text-sm text-accent-red"
          >
            {applyState.message}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            className="rounded-lg bg-accent-green px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-green"
            disabled={applyBlocked}
            aria-busy={applyState.phase === 'applying'}
            onClick={handleApply}
          >
            启用计划
          </button>
          <button
            type="button"
            className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-medium text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-green"
            onClick={onDiscard}
          >
            放弃
          </button>
        </div>
      </section>
    </WorkspaceLayout>
  )
}
