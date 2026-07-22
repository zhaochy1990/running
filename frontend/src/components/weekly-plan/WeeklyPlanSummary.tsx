import { useState } from 'react'
import { formatWeekRange, type PlanDay, type WeekDetail } from '../../api'
import { computeWeekPlanIntensity } from '../../lib/planIntensity'
import { actualRunDistanceKm, actualStrengthStats, formatDurationClock, weeklyPlanStats } from '../../lib/weeklyPlanView'
import RegenerateWeekModal from './RegenerateWeekModal'

export interface WeeklyPlanSummaryProps {
  readonly week: WeekDetail
  readonly days: readonly PlanDay[]
  readonly planTitle?: string
  readonly folder?: string | null
  readonly onRegenerated?: () => void
}

export default function WeeklyPlanSummary({ week, days, planTitle, folder, onRegenerated }: WeeklyPlanSummaryProps) {
  const [regenerating, setRegenerating] = useState(false)
  const stats = weeklyPlanStats(days)
  const plannedIntensity = computeWeekPlanIntensity(stats.sessions)
  const actualRunKm = actualRunDistanceKm(week.activities)
  const actualStrength = actualStrengthStats(week.activities)
  const displayPlanTitle = planTitle?.trim() === '本周训练重点' ? undefined : planTitle
  const completion = stats.plannedRunKm > 0
    ? Math.min(100, Math.round((actualRunKm / stats.plannedRunKm) * 100))
    : 0

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-accent-green">Coach Agent · Weekly Plan</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-text-primary">本周课表</h1>
          <p className="mt-2 text-sm text-text-muted">{formatWeekRange(week.date_from, week.date_to)}{displayPlanTitle ? ` · ${displayPlanTitle}` : ''}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden rounded-xl border border-border-subtle bg-bg-card px-4 py-2.5 sm:block">
            <p className="font-mono text-[10px] tracking-wider text-text-muted">实际跑量</p>
            <p className="mt-1 font-mono text-lg font-bold text-text-primary">{actualRunKm.toFixed(1)} <span className="text-xs font-normal text-text-muted">km</span></p>
          </div>
          <div className="hidden rounded-xl border border-border-subtle bg-bg-card px-4 py-2.5 sm:block">
            <p className="font-mono text-[10px] tracking-wider text-text-muted">完成度</p>
            <div className="mt-1 flex items-center gap-2"><span className="font-mono text-lg font-bold text-text-primary">{completion}%</span><span className="h-1.5 w-14 overflow-hidden rounded-full bg-bg-secondary"><span className="block h-full rounded-full bg-accent-green" style={{ width: `${completion}%` }} /></span></div>
          </div>
          <button
            type="button"
            data-testid="regenerate-week-button"
            onClick={() => setRegenerating(true)}
            disabled={!folder}
            title={folder ? '重新生成本周训练计划' : '本周不可调整'}
            className="rounded-lg bg-accent-green px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60"
          >
            调整本周
          </button>
        </div>
      </div>

      {regenerating && folder && (
        <RegenerateWeekModal
          folder={folder}
          week={week}
          currentDays={days}
          onClose={() => setRegenerating(false)}
          onApplied={() => onRegenerated?.()}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-border-subtle bg-bg-card p-5 shadow-sm">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-text-muted">本周结构</p>
            <p className="mt-1 text-sm text-text-secondary">结构化计划实时汇总</p>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric label="计划跑量" value={`${stats.plannedRunKm.toFixed(1)} km`} accent />
            <Metric label="低强度 Z1+Z2" value={`${plannedIntensity.low_km.toFixed(1)} km`} accent />
            <Metric label="高强度 Z4+Z5" value={`${plannedIntensity.high_km.toFixed(1)} km`} accent />
            <Metric label="训练课" value={`${stats.sessions.length}`} />
            <Metric label="跑步课" value={`${stats.runCount}`} />
            <Metric label="营养日" value={`${stats.nutritionDays}`} />
          </div>
        </div>
        <aside className="rounded-2xl border border-green-edge bg-green-soft p-5">
          <p className="text-xs font-bold uppercase tracking-wider text-accent-green">本周训练重点</p>
          <p className="mt-3 text-lg font-bold leading-7 text-text-primary">{stats.runCount} 次跑步 + {stats.strengthCount} 次力量维护</p>
          <p className="mt-3 font-editorial text-sm italic leading-6 text-text-secondary">“优先完成关键课，其余训练按恢复状态灵活降级。训练后的真实体感会用于后续 Coach 调整。”</p>
          <div className="mt-4 space-y-1 border-t border-green-edge pt-3 text-xs text-text-secondary">
            <p>实际完成 {week.activity_count} 次 · 跑步 {actualRunKm.toFixed(1)} km · {week.total_duration_fmt}</p>
            <p>力量训练 {actualStrength.count} 次 · {formatDurationClock(actualStrength.durationS)}</p>
          </div>
        </aside>
      </div>
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
