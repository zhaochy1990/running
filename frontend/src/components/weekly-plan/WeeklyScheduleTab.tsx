import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { formatDateShort, weekdayCN, type PlanDay, type WeekDetail } from '../../api'
import CoachWeeklyPlanEmptyState from './CoachWeeklyPlanEmptyState'

export interface WeeklyScheduleTabProps {
  readonly week: WeekDetail
  readonly days: readonly PlanDay[]
}

export default function WeeklyScheduleTab({ week, days }: WeeklyScheduleTabProps) {
  if (days.length === 0 && !week.plan?.trim()) {
    return <CoachWeeklyPlanEmptyState />
  }

  if (days.length === 0) {
    return <div className="prose rounded-2xl border border-border-subtle bg-bg-card p-6"><ReactMarkdown remarkPlugins={[remarkGfm]}>{week.plan}</ReactMarkdown></div>
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-card">
      {days.flatMap((day) => day.sessions.map((session) => (
        <article key={`${session.date}-${session.session_index}`} className="grid gap-4 border-b border-border-subtle p-4 last:border-b-0 sm:grid-cols-[84px_1fr_auto]">
          <div className="border-border-subtle sm:border-r">
            <p className="text-xs font-medium uppercase text-text-muted">{weekdayCN(session.date)}</p>
            <p className="mt-1 font-mono text-lg font-bold text-text-primary">{formatDateShort(session.date)}</p>
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${session.kind === 'run' ? 'bg-green-soft text-accent-green' : session.kind === 'strength' ? 'bg-cyan-soft text-accent-cyan' : 'bg-bg-secondary text-text-muted'}`}>{session.kind}</span>
              <h2 className="text-sm font-bold text-text-primary">{session.summary}</h2>
            </div>
            <p className="mt-2 text-xs leading-5 text-text-secondary">{session.notes_md || session.spec?.note || '按当日恢复状态执行，保持动作和配速质量。'}</p>
          </div>
          <div className="font-mono text-xs text-text-muted sm:text-right">
            {session.total_distance_m ? `${(session.total_distance_m / 1000).toFixed(1)} km` : session.total_duration_s ? `${Math.round(session.total_duration_s / 60)} min` : '—'}
          </div>
        </article>
      )))}
    </div>
  )
}
