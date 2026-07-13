import type { StrengthTabResponse } from '../../types/strength'

export interface WeeklyStrengthTabProps {
  readonly data: StrengthTabResponse | null
}

export default function WeeklyStrengthTab({ data }: WeeklyStrengthTabProps) {
  if (!data?.sessions.length) return <EmptyState text="本周没有独立力量训练安排" />
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {data.sessions.map((session) => (
        <article key={`${session.date}-${session.session_index}`} className="rounded-2xl border border-border-subtle bg-bg-card p-5">
          <p className="font-mono text-xs text-accent-cyan">{session.date}</p>
          <h2 className="mt-2 text-lg font-bold text-text-primary">{session.summary}</h2>
          <div className="mt-4 space-y-3">
            {session.exercises.map((exercise) => (
              <div key={exercise.canonical_id} className="flex items-start justify-between gap-4 rounded-xl bg-bg-secondary p-3">
                <div><p className="text-sm font-semibold text-text-primary">{exercise.display_name}</p><p className="mt-1 text-xs text-text-muted">{exercise.note || '保持控制与稳定'}</p></div>
                <span className="whitespace-nowrap font-mono text-xs text-accent-cyan">{exercise.sets} × {exercise.target_value}{exercise.target_kind === 'time_s' ? 's' : ''}</span>
              </div>
            ))}
          </div>
        </article>
      ))}
    </div>
  )
}

function EmptyState({ text }: Readonly<{ text: string }>) {
  return <div className="rounded-2xl border border-dashed border-border bg-bg-card py-16 text-center text-sm text-text-muted">{text}</div>
}
