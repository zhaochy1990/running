import { formatWeekRange, type WeekDetail } from '../../api'

export interface WeeklyPlanSummaryProps {
  readonly week: WeekDetail
}

export default function WeeklyPlanSummary({ week }: WeeklyPlanSummaryProps) {
  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="rounded-2xl border border-border-subtle bg-bg-card p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent-green">Coach Agent · Weekly Plan</p>
            <h1 className="mt-2 text-3xl font-bold text-text-primary">本周训练课表</h1>
            <p className="mt-2 text-sm text-text-muted">{formatWeekRange(week.date_from, week.date_to)} · Coach 根据赛季目标、近期训练与恢复状态生成</p>
          </div>
          <button type="button" disabled title="Coach 本周调整流程即将开放" className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-muted opacity-70">
            调整本周 · 即将开放
          </button>
        </div>
        <div className="mt-6 grid grid-cols-3 gap-3">
          <Metric label="已完成训练" value={`${week.activity_count}`} />
          <Metric label="实际里程" value={`${week.total_km.toFixed(1)} km`} accent />
          <Metric label="实际时长" value={week.total_duration_fmt} />
        </div>
      </div>
      <aside className="rounded-2xl border border-green-edge bg-green-soft p-5">
        <p className="text-xs font-bold uppercase tracking-wider text-accent-green">Coach 本周提示</p>
        <p className="mt-3 text-sm leading-6 text-text-secondary">优先完成关键课，其余训练按恢复状态灵活降级。每次训练后的体感会用于后续 Coach 调整。</p>
      </aside>
    </section>
  )
}

function Metric({ label, value, accent = false }: Readonly<{ label: string; value: string; accent?: boolean }>) {
  return (
    <div className="rounded-xl bg-bg-secondary p-3">
      <p className="text-[11px] text-text-muted">{label}</p>
      <p className={`mt-1 font-mono text-sm font-bold ${accent ? 'text-accent-green' : 'text-text-primary'}`}>{value}</p>
    </div>
  )
}
