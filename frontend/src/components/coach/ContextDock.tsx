import type { CoachProposalCard, CoachTargetRef, StrideTrainingLoadRecord } from '../../api'
import { isWeekDiff } from '../../api'

interface ContextDockProps {
  activeTarget: CoachTargetRef | null
  load: StrideTrainingLoadRecord | null
  proposals: CoachProposalCard[]
}

function targetHeading(target: CoachTargetRef | null): { eyebrow: string; title: string } {
  if (!target) return { eyebrow: '当前对象', title: '尚未锁定对象' }
  if (target.kind === 'master') return { eyebrow: '当前对象 · 赛季计划', title: target.plan_id ?? '当前赛季计划' }
  if (target.kind === 'session') {
    return { eyebrow: '当前对象 · 单次课', title: `${target.folder ?? ''} · ${target.date ?? ''}` }
  }
  return { eyebrow: '当前对象 · 周计划', title: target.folder ?? '本周' }
}

function MetricChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card px-2.5 py-2 flex-1 min-w-0">
      <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">{label}</div>
      <div className="text-base font-semibold text-text-primary tabular-nums mt-0.5">{value}</div>
    </div>
  )
}

const fmt = (n: number | null | undefined, digits = 0): string =>
  n == null ? '—' : n.toFixed(digits)

export default function ContextDock({ activeTarget, load, proposals }: ContextDockProps) {
  const { eyebrow, title } = targetHeading(activeTarget)
  const form = load?.form ?? null
  const formStr = form == null ? '—' : `${form > 0 ? '+' : ''}${form.toFixed(0)}`

  const affectedFolders = Array.from(
    new Set(
      proposals
        .map((p) => (isWeekDiff(p.proposal) ? p.proposal.folder : p.proposal.plan_id))
        .filter(Boolean) as string[],
    ),
  )

  return (
    <aside className="w-[340px] flex-shrink-0 border-l border-border-subtle bg-bg-card overflow-y-auto p-4 hidden xl:block">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent-green">{eyebrow}</div>
        <div className="text-sm font-semibold text-text-primary mt-1 break-words">{title}</div>
      </div>

      <div className="mt-4">
        <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted mb-1.5">训练负荷</div>
        <div className="flex gap-2">
          <MetricChip label="CTL" value={fmt(load?.chronic_load)} />
          <MetricChip label="ATL" value={fmt(load?.acute_load)} />
          <MetricChip label="FORM" value={formStr} />
        </div>
      </div>

      {affectedFolders.length > 0 && (
        <div className="mt-4">
          <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted mb-1.5">本提案影响</div>
          <div className="space-y-1">
            {affectedFolders.map((f) => (
              <div key={f} className="font-mono text-[11px] text-accent-green-dim break-all">{f}</div>
            ))}
          </div>
        </div>
      )}

      <p className="text-[11px] text-text-muted mt-5 leading-relaxed">
        对话即入口：问状态、调计划、聊伤病。涉及改计划时先出提案，确认后才生效。
      </p>
    </aside>
  )
}
