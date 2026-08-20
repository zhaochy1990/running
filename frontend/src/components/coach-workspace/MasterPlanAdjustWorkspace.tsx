import { useState } from 'react'
import type { ReactNode } from 'react'
import { DiffReview } from './DiffReview'
import { WorkspaceLayout } from './WorkspaceLayout'
import type {
  ApplyOutcome,
  ApplyProposalRequest,
  MasterDiffProposal,
  StashedProposal,
} from './types'

interface MasterPlanAdjustWorkspaceProps {
  readonly stashed: StashedProposal<MasterDiffProposal>
  readonly currentPlanSummary: string
  readonly onApply: (req: ApplyProposalRequest) => Promise<ApplyOutcome>
  readonly onDiscard: () => void
  readonly chat: ReactNode
  readonly onApplied?: () => void
}

type ApplyState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'applying' }
  | { readonly phase: 'stale' }
  | { readonly phase: 'error'; readonly message: string }

/**
 * Middle+right columns of the master (season) plan-adjust workspace. A single
 * MasterPlanDiff proposal is reviewed and applied as one unit, carrying every op
 * id and the base revision. On success the caller navigates back to /plan.
 */
export function MasterPlanAdjustWorkspace({
  stashed,
  currentPlanSummary,
  onApply,
  onDiscard,
  chat,
  onApplied,
}: MasterPlanAdjustWorkspaceProps) {
  const { proposal } = stashed
  const [applyState, setApplyState] = useState<ApplyState>({ phase: 'idle' })

  async function handleApply(): Promise<void> {
    if (applyState.phase === 'applying') return
    setApplyState({ phase: 'applying' })
    const req: ApplyProposalRequest = {
      opIds: proposal.changes.map((c) => c.opId),
      baseRevision: proposal.baseRevision,
    }
    try {
      const outcome = await onApply(req)
      if (outcome.status === 'ok') {
        setApplyState({ phase: 'idle' })
        onApplied?.()
      } else if (outcome.status === 'stale') {
        setApplyState({ phase: 'stale' })
      } else if (outcome.status === 'needs_ack') {
        // The master path has no material-impact gate; treat as an error.
        setApplyState({ phase: 'error', message: outcome.seasonImpact })
      } else {
        setApplyState({ phase: 'error', message: outcome.message })
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '启用失败，请重试'
      setApplyState({ phase: 'error', message })
    }
  }

  return (
    <WorkspaceLayout title="调整赛季计划" chat={chat}>
      <section className="space-y-4">
        <div className="rounded-lg border border-border-subtle bg-bg-card p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-text-muted">
            当前赛季计划
          </div>
          <div className="mt-1 text-sm text-text-primary">{currentPlanSummary}</div>
        </div>

        <div className="rounded-lg border border-border-subtle bg-bg-card p-4">
          <div className="mb-3 text-sm font-medium text-text-primary">{proposal.summary}</div>
          <DiffReview changes={proposal.changes} />
        </div>

        {applyState.phase === 'stale' && (
          <div
            role="alert"
            className="rounded-lg border border-accent-red/30 bg-red-soft p-3 text-sm text-accent-red"
          >
            <p>方案已过期：赛季计划在生成方案后发生了变化。</p>
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
            disabled={applyState.phase === 'applying'}
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
