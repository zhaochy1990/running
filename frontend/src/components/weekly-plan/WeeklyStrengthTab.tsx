import { formatDateShort, weekdayCN, type PlanDay } from '../../api'
import type { StrengthTabResponse, StrengthTabSession } from '../../types/strength'

export interface WeeklyStrengthTabProps {
  readonly data: StrengthTabResponse | null
  readonly days: readonly PlanDay[]
}

export default function WeeklyStrengthTab({ data, days }: WeeklyStrengthTabProps) {
  if (!data?.sessions.length) return <EmptyState text="本周没有独立力量训练安排" />
  const totalExercises = data.sessions.reduce((total, session) => total + session.exercises.length, 0)

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="space-y-5">
        <section className="rounded-2xl border border-border-subtle bg-bg-card p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-text-muted">本周力量训练 · from structured sessions</p>
              <h2 className="mt-2 text-2xl font-bold text-text-primary">{data.sessions.length} 次力量维护，服务本周跑步计划</h2>
              <p className="mt-2 text-sm text-text-muted">动作、组数和执行重点来自结构化力量计划，优先显示可执行中文。</p>
            </div>
            <span className="rounded-full bg-purple-soft px-3 py-1 font-mono text-xs font-bold text-accent-purple">{totalExercises} 个动作</span>
          </div>
          <div className="mt-6 grid gap-4 xl:grid-cols-2">
            {data.sessions.map((session) => <StrengthSessionCard key={`${session.date}-${session.session_index}`} session={session} />)}
          </div>
        </section>

        <section className="rounded-2xl border border-border-subtle bg-bg-card p-5 shadow-sm">
          <h3 className="text-sm font-bold text-text-primary">与跑步课的关系</h3>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {data.sessions.map((session) => {
              const run = days.find((day) => day.date === session.date)?.sessions.find((item) => item.kind === 'run')
              return (
                <div key={`${session.date}-relationship`} className="rounded-xl bg-bg-secondary p-4">
                  <p className="text-xs font-bold text-accent-purple">{weekdayCN(session.date)}</p>
                  <p className="mt-2 text-sm font-semibold text-text-primary">{run ? `承接「${run.summary}」` : '独立力量维护'}</p>
                  <p className="mt-2 text-xs leading-5 text-text-muted">动作质量优先，不额外制造跑步强度；如当日腿部疲劳明显，可减少一组。</p>
                </div>
              )
            })}
            <div className="rounded-xl bg-bg-secondary p-4">
              <p className="text-xs font-bold text-accent-purple">执行原则</p>
              <p className="mt-2 text-sm font-semibold text-text-primary">不追求力竭或爆发</p>
              <p className="mt-2 text-xs leading-5 text-text-muted">力量训练服务跑姿、稳定性和伤病预防，避免影响下一节关键跑步课。</p>
            </div>
          </div>
        </section>
      </div>

      <aside className="space-y-4">
        <div className="rounded-xl border border-border-subtle bg-bg-card p-5 shadow-sm">
          <h3 className="text-sm font-bold text-text-primary">执行规则</h3>
          <ul className="mt-4 space-y-3 text-xs leading-5 text-text-secondary"><li>动作名和组数来自本周结构化计划。</li><li>左右侧动作按每侧完成。</li><li>动作质量优先于次数和负重。</li></ul>
        </div>
        <div className="rounded-xl border border-accent-amber/30 bg-amber-soft p-5">
          <h3 className="text-sm font-bold text-accent-amber">疲劳调整</h3>
          <p className="mt-2 text-xs leading-5 text-text-secondary">关键跑步课后若小腿、跟腱或髋部反应明显，只保留核心和灵活性动作，并在反馈 Tab 记录。</p>
        </div>
      </aside>
    </div>
  )
}

interface StrengthSessionCardProps {
  readonly session: StrengthTabSession
}

function StrengthSessionCard({ session }: StrengthSessionCardProps) {
  return (
    <article className="rounded-xl border border-border-subtle p-5">
      <p className="font-mono text-xs text-accent-purple">{weekdayCN(session.date)} · {formatDateShort(session.date)}</p>
      <h3 className="mt-2 text-lg font-bold text-text-primary">{session.summary}</h3>
      <div className="mt-4 space-y-3">
        {session.exercises.map((exercise) => (
          <div key={exercise.canonical_id} className="rounded-xl bg-bg-secondary p-3">
            <div className="flex items-start justify-between gap-4">
              <p className="text-sm font-semibold text-text-primary">{exercise.name_zh || exercise.display_name}</p>
              <span className="whitespace-nowrap font-mono text-xs text-accent-purple">{exercise.sets} × {exercise.target_value}{exercise.target_kind === 'time_s' ? 's' : ''}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-text-muted">{exercise.note || exercise.key_points[0] || '保持控制与稳定'}</p>
          </div>
        ))}
      </div>
      {session.notes_md && <p className="mt-4 rounded-lg bg-purple-soft p-3 text-xs leading-5 text-text-secondary">{session.notes_md}</p>}
    </article>
  )
}

interface EmptyStateProps { readonly text: string }
function EmptyState({ text }: EmptyStateProps) {
  return <div className="rounded-2xl border border-dashed border-border bg-bg-card py-16 text-center text-sm text-text-muted">{text}</div>
}
