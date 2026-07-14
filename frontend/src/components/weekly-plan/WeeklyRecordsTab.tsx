import { Link } from 'react-router-dom'
import { formatDateShort, sportNameCN, type Activity, type PlanDay } from '../../api'
import { actualRunDistanceKm, weeklyPlanStats } from '../../lib/weeklyPlanView'

export interface WeeklyRecordsTabProps {
  readonly days: readonly PlanDay[]
  readonly activities: readonly Activity[]
}

export default function WeeklyRecordsTab({ days, activities }: WeeklyRecordsTabProps) {
  const stats = weeklyPlanStats(days)
  const actualRunKm = actualRunDistanceKm(activities)
  const mileagePct = stats.plannedRunKm > 0 ? Math.min(100, Math.round(actualRunKm / stats.plannedRunKm * 100)) : 0

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="space-y-5">
        <section className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-card shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border-subtle p-5">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-text-muted">实际训练</p>
              <h2 className="mt-2 text-2xl font-bold text-text-primary">本周训练记录</h2>
              <p className="mt-2 text-sm text-text-muted">展示本周已同步的全部活动，不要求与计划课逐项对应。</p>
            </div>
            <span className="rounded-full border border-border-subtle bg-bg-secondary px-3 py-1 text-xs font-bold text-text-secondary">{activities.length} 次记录</span>
          </div>
          <div className="divide-y divide-border-subtle">
            {activities.length === 0 ? <p className="p-8 text-center text-sm text-text-muted">本周暂无已同步训练</p> : activities.map((activity) => (
              <div key={activity.label_id} className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_120px_120px_86px] sm:items-center">
                <div className="min-w-0">
                  <Link to={`/activity/${activity.label_id}`} className="block truncate text-sm font-bold text-text-primary hover:text-accent-green hover:underline">
                    {activity.name || sportNameCN(activity.sport_name)}
                  </Link>
                  <p className="mt-1 font-mono text-[11px] text-text-muted">{sportNameCN(activity.sport_name)}{activity.train_type ? ` · ${activity.train_type}` : ''}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase text-text-muted">训练数据</p>
                  <p className="mt-1 font-mono text-sm font-bold text-accent-green">{activity.distance_km > 0 ? `${activity.distance_km.toFixed(1)} km` : activity.duration_fmt}</p>
                </div>
                <div><p className="text-[10px] uppercase text-text-muted">日期</p><p className="mt-1 font-mono text-xs text-text-secondary">{formatDateShort(activity.date)}</p></div>
                <span className="w-fit rounded-full bg-green-soft px-2 py-1 text-[10px] font-bold text-accent-green">已同步</span>
              </div>
            ))}
          </div>
        </section>
        <section className="rounded-2xl border border-border-subtle bg-bg-card p-5 shadow-sm">
          <h3 className="text-sm font-bold text-text-primary">完成后重点复盘</h3>
          <div className="mt-4 grid gap-3 sm:grid-cols-3"><QualityCard label="关键课稳定性" /><QualityCard label="低强度承接质量" /><QualityCard label="营养执行" /></div>
        </section>
      </div>
      <aside className="space-y-4">
        <div className="rounded-xl border border-border-subtle bg-bg-card p-5 shadow-sm"><h3 className="text-sm font-bold text-text-primary">本周汇总</h3><Progress label="跑量" value={`${actualRunKm.toFixed(1)} / ${stats.plannedRunKm.toFixed(1)} km`} percent={mileagePct} /><SummaryValue label="已同步活动" value={`${activities.length} 次`} /></div>
        <div className="rounded-xl border border-amber-soft bg-amber-soft/40 p-5"><h3 className="text-sm font-bold text-text-primary">Coach 复盘提示</h3><p className="mt-3 font-editorial text-sm italic leading-6 text-text-secondary">同步后优先查看关键课目标是否稳定、轻松跑是否守住低强度，以及营养日是否按计划执行。</p></div>
      </aside>
    </div>
  )
}

interface ProgressProps { readonly label: string; readonly value: string; readonly percent: number }
function Progress({ label, value, percent }: ProgressProps) { return <div className="mt-5"><div className="flex justify-between text-xs"><span>{label}</span><span className="font-mono">{value}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-bg-secondary"><div className="h-full rounded-full bg-accent-green" style={{ width: `${percent}%` }} /></div></div> }
interface SummaryValueProps { readonly label: string; readonly value: string }
function SummaryValue({ label, value }: SummaryValueProps) { return <div className="mt-5 flex justify-between border-t border-border-subtle pt-4 text-xs"><span>{label}</span><span className="font-mono font-bold text-text-primary">{value}</span></div> }
interface QualityCardProps { readonly label: string }
function QualityCard({ label }: QualityCardProps) { return <div className="rounded-xl bg-bg-secondary p-4"><p className="text-xs font-bold text-text-muted">{label}</p><p className="mt-2 font-mono text-2xl font-bold text-text-muted">—</p></div> }
