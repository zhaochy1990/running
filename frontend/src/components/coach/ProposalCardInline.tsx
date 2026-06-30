import type { CoachProposalCard } from '../../api'
import { proposalTargetLabel } from './diffHelpers'
import { SparkIcon } from './CoachIcons'

interface ProposalCardInlineProps {
  card: CoachProposalCard
  applied?: boolean
  onReview: () => void
}

/**
 * Compact in-conversation proposal card (Pattern Y). Summarizes the proposed
 * change; the full op-by-op diff + apply lives in review mode. A clarification
 * turn never renders this (the page gates on `clarification == null`).
 */
export default function ProposalCardInline({ card, applied, onReview }: ProposalCardInlineProps) {
  const opCount = card.proposal.ops.length
  return (
    <div className="mt-2 rounded-xl border border-border bg-bg-card p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-accent-green-dim">
            <SparkIcon />
            提案 · {proposalTargetLabel(card)}
          </div>
          {card.summary && (
            <div className="text-sm font-semibold text-text-primary mt-1 break-words">{card.summary}</div>
          )}
        </div>
        <span className="font-mono text-[11px] text-text-muted whitespace-nowrap">{opCount} 项</span>
      </div>
      <div className="flex items-center gap-2 mt-2.5">
        {applied ? (
          <span className="inline-flex items-center h-7 px-2.5 rounded-md bg-accent-green/10 text-accent-green-dim text-[11px] font-semibold">
            已采纳
          </span>
        ) : (
          <button
            type="button"
            onClick={onReview}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-accent-green text-white text-[11px] font-semibold hover:bg-accent-green-dim transition-colors"
          >
            展开审阅
          </button>
        )}
        <span className="font-mono text-[9px] text-text-muted tracking-wide">写操作需确认，绝不自动改动计划</span>
      </div>
    </div>
  )
}
