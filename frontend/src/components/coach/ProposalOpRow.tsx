import { opLabel, opPillClass, summarizeOp, type AnyDiffOp } from './diffHelpers'

interface ProposalOpRowProps {
  op: AnyDiffOp
  checked: boolean
  onToggle: () => void
}

/** A single selectable diff op (generalized from TrainingPlanAdjustPage's DiffOpRow). */
export default function ProposalOpRow({ op, checked, onToggle }: ProposalOpRowProps) {
  return (
    <label className="flex items-start gap-2.5 rounded-lg border border-border-subtle bg-bg-card p-2.5 cursor-pointer hover:bg-bg-card-hover transition-colors">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-0.5 accent-accent-green"
      />
      <span className="min-w-0 flex-1">
        <span
          className={`inline-block font-mono text-[9px] uppercase tracking-[0.1em] px-1.5 py-0.5 rounded border ${opPillClass(op.op)}`}
        >
          {opLabel(op.op)}
        </span>
        <span className="block text-[11px] text-text-secondary mt-1 break-words">{summarizeOp(op)}</span>
      </span>
    </label>
  )
}
