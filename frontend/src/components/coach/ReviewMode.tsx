import type { CoachProposalCard } from '../../api'
import {
  opLabel,
  opPillClass,
  proposalTargetLabel,
  summarizeNew,
  summarizeOld,
  type AnyDiffOp,
  type ApplyOutcome,
} from './diffHelpers'
import { BackIcon, CheckIcon, RefreshIcon } from './CoachIcons'

interface ReviewModeProps {
  card: CoachProposalCard
  selectedOpIds: Set<string>
  onToggleOp: (opId: string) => void
  onApply: () => void
  onBack: () => void
  applying: boolean
  applyError: string | null
  applyOutcome: ApplyOutcome | null
}

function OpComparison({
  op,
  checked,
  onToggle,
}: {
  op: AnyDiffOp
  checked: boolean
  onToggle: () => void
}) {
  return (
    <div className="rounded-xl border border-border-subtle bg-bg-card p-3">
      <label className="flex items-center gap-2.5 cursor-pointer">
        <input type="checkbox" checked={checked} onChange={onToggle} className="accent-accent-green" />
        <span
          className={`font-mono text-[9px] uppercase tracking-[0.1em] px-1.5 py-0.5 rounded border ${opPillClass(op.op)}`}
        >
          {opLabel(op.op)}
        </span>
      </label>
      <div className="grid grid-cols-2 gap-3 mt-2.5">
        <div className="rounded-lg border border-border-subtle bg-bg-primary p-2.5">
          <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted mb-1">当前</div>
          <div className="text-[12px] text-text-secondary break-words">{summarizeOld(op)}</div>
        </div>
        <div className="rounded-lg border border-green-edge bg-green-soft p-2.5">
          <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-accent-green-dim mb-1">调整后</div>
          <div className="text-[12px] text-text-primary break-words">{summarizeNew(op)}</div>
        </div>
      </div>
    </div>
  )
}

/** Artifact-primary review of a write proposal: per-op 当前↔调整后 + apply bar. */
export default function ReviewMode({
  card,
  selectedOpIds,
  onToggleOp,
  onApply,
  onBack,
  applying,
  applyError,
  applyOutcome,
}: ReviewModeProps) {
  const ops = card.proposal.ops as AnyDiffOp[]
  const selectedCount = ops.filter((op) => selectedOpIds.has(op.id)).length
  const applied = applyOutcome?.ok ?? false

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent-green">
            提案审阅 · {proposalTargetLabel(card)}
          </div>
          <h2 className="text-lg font-semibold text-text-primary mt-0.5 break-words">
            {card.summary || '调整提案'}
          </h2>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border-subtle bg-bg-card text-[12px] font-semibold text-text-secondary hover:text-text-primary hover:border-border transition-colors flex-shrink-0"
        >
          <BackIcon />
          返回对话
        </button>
      </div>

      {card.proposal.ai_explanation && (
        <p className="text-[13px] text-text-secondary mb-3">{card.proposal.ai_explanation}</p>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
        {ops.map((op) => (
          <OpComparison
            key={op.id}
            op={op}
            checked={selectedOpIds.has(op.id)}
            onToggle={() => onToggleOp(op.id)}
          />
        ))}
      </div>

      {applyError && (
        <div className="mt-3 rounded-xl border border-accent-red/30 bg-accent-red/5 p-3 text-[12px] text-accent-red">
          {applyError}
        </div>
      )}
      {applied && applyOutcome && (
        <div className="mt-3 rounded-xl border border-accent-green/25 bg-accent-green/5 p-3 text-[12px] text-accent-green-dim">
          {applyOutcome.detail}
        </div>
      )}

      <div className="flex items-center gap-2 pt-3 mt-1 border-t border-border-subtle">
        <button
          type="button"
          onClick={onApply}
          disabled={selectedCount === 0 || applying || applied}
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-accent-green text-white text-[13px] font-semibold hover:bg-accent-green-dim disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
        >
          <CheckIcon />
          {applying ? '应用中…' : applied ? '已采纳' : `采纳所选 (${selectedCount})`}
        </button>
        {!applied && (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border-subtle bg-bg-card text-[13px] font-semibold text-text-secondary hover:text-text-primary hover:border-border transition-colors"
          >
            <RefreshIcon />
            再调整一下
          </button>
        )}
        <span className="font-mono text-[9px] text-text-muted tracking-wide ml-auto">
          写操作需确认 · Pattern Y
        </span>
      </div>
    </div>
  )
}
