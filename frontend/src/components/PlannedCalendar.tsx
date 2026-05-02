import type { PlannedNutrition, PlannedSession, StructuredStatus } from '../types/plan'
import { weekdayCN, formatDateShort } from '../api'
import PushPlannedButton from './PushPlannedButton'

export interface PlannedCalendarProps {
  /** ISO YYYY-MM-DD strings, length 7, ascending. */
  weekDates: string[]
  sessions: PlannedSession[]
  nutrition: PlannedNutrition[]
  structuredStatus: StructuredStatus
  canPushRun: boolean
  onPush: (s: PlannedSession) => Promise<void> | void
}

const KIND_ICON: Record<PlannedSession['kind'], string> = {
  run: '🏃',
  strength: '💪',
  rest: '😴',
  cross: '🚴',
  note: '📝',
}

const KIND_LABEL: Record<PlannedSession['kind'], string> = {
  run: '跑步',
  strength: '力量',
  rest: '休息',
  cross: '交叉',
  note: '说明',
}

const KIND_COLOR: Record<PlannedSession['kind'], string> = {
  run: '#00a85a',
  strength: '#e68a00',
  rest: '#8888a0',
  cross: '#0097a7',
  note: '#7c4dff',
}

function fmtKm(m: number | null): string {
  if (m == null) return '—'
  return `${(m / 1000).toFixed(1)} km`
}

function fmtMin(s: number | null): string {
  if (s == null) return '—'
  return `${Math.round(s / 60)} min`
}

function fmtPaceSecKm(s: number | null | undefined): string {
  if (s == null) return '—'
  const total = Math.round(s)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}/km`
}

function paceTargetText(s: PlannedSession): string | null {
  if (!s.spec || s.spec.schema !== 'run-workout/v1') return null
  // Surface the first non-warmup pace target found, plus the first HR target.
  for (const block of s.spec.blocks) {
    for (const step of block.steps) {
      if (step.target.kind === 'pace_s_km' && step.target.low != null && step.target.high != null) {
        return `${fmtPaceSecKm(step.target.high)} – ${fmtPaceSecKm(step.target.low)}`
      }
    }
  }
  return null
}

function hrTargetText(s: PlannedSession): string | null {
  if (!s.spec || s.spec.schema !== 'run-workout/v1') return null
  for (const block of s.spec.blocks) {
    for (const step of block.steps) {
      if (step.target.kind === 'hr_bpm' && step.target.low != null && step.target.high != null) {
        return `${Math.round(step.target.low)}–${Math.round(step.target.high)} bpm`
      }
    }
  }
  return null
}

function rpeText(s: PlannedSession): string | null {
  // RPE is conventionally encoded inside `notes_md` as "RPE N". Best-effort
  // surface: look for "RPE <num>" anywhere in summary or notes.
  const haystack = `${s.summary} ${s.notes_md ?? ''}`
  const m = /RPE\s*(\d+(?:\.\d+)?)/i.exec(haystack)
  return m ? `RPE ${m[1]}` : null
}

export default function PlannedCalendar({
  weekDates,
  sessions,
  nutrition,
  structuredStatus,
  canPushRun,
  onPush,
}: PlannedCalendarProps) {
  if (structuredStatus === 'parse_failed' || structuredStatus === 'none') {
    return (
      <div
        data-testid="planned-calendar-empty"
        className="bg-bg-card border border-border-subtle rounded-2xl p-6 text-center text-sm text-text-muted"
      >
        本周计划暂未结构化，请重新解析后查看日历视图
      </div>
    )
  }

  const sessionsByDate = new Map<string, PlannedSession[]>()
  for (const s of sessions) {
    const list = sessionsByDate.get(s.date) ?? []
    list.push(s)
    sessionsByDate.set(s.date, list)
  }
  const nutritionByDate = new Map<string, PlannedNutrition>()
  for (const n of nutrition) nutritionByDate.set(n.date, n)

  return (
    <div data-testid="planned-calendar" className="space-y-3">
      {structuredStatus === 'backfilled' && (
        <div
          data-testid="backfill-banner"
          role="alert"
          className="bg-accent-amber/10 border border-accent-amber/30 rounded-xl px-4 py-2.5 text-xs font-mono text-accent-amber"
        >
          历史回填的计划，请先在 markdown 视图核对后审核启用 — 推送到手表的按钮已禁用
        </div>
      )}
      {structuredStatus === 'stale' && (
        <div
          data-testid="stale-banner"
          role="alert"
          className="bg-accent-cyan/10 border border-accent-cyan/30 rounded-xl px-4 py-2.5 text-xs font-mono text-accent-cyan"
        >
          结构化数据已过期，请触发"重新解析"
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3">
        {weekDates.map((date) => {
          const daySessions = (sessionsByDate.get(date) ?? []).slice().sort(
            (a, b) => a.session_index - b.session_index,
          )
          const dayNutrition = nutritionByDate.get(date) ?? null

          return (
            <div
              key={date}
              data-testid="day-card"
              data-date={date}
              className="bg-bg-card border border-border-subtle rounded-xl p-3 flex flex-col gap-2 min-h-[160px]"
            >
              <div className="flex items-baseline justify-between border-b border-border-subtle pb-1.5">
                <span className="text-xs font-mono text-text-muted">{weekdayCN(date)}</span>
                <span className="text-xs font-mono text-text-secondary">
                  {formatDateShort(date)}
                </span>
              </div>

              {daySessions.length === 0 ? (
                <p className="text-xs font-mono text-text-muted">无计划</p>
              ) : (
                daySessions.map((s) => {
                  const pace = paceTargetText(s)
                  const hr = hrTargetText(s)
                  const rpe = rpeText(s)
                  return (
                    <div
                      key={`${s.date}-${s.session_index}`}
                      data-testid="session-row"
                      className="flex flex-col gap-1 rounded-lg border border-border-subtle px-2 py-1.5"
                    >
                      <div className="flex items-center gap-1.5">
                        <span aria-hidden="true">{KIND_ICON[s.kind]}</span>
                        <span
                          className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                          style={{
                            color: KIND_COLOR[s.kind],
                            backgroundColor: KIND_COLOR[s.kind] + '15',
                          }}
                        >
                          {KIND_LABEL[s.kind]}
                        </span>
                      </div>
                      <p className="text-xs text-text-primary leading-snug">{s.summary}</p>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-mono text-text-muted">
                        {s.total_distance_m != null && (
                          <span>距离 {fmtKm(s.total_distance_m)}</span>
                        )}
                        {s.total_duration_s != null && (
                          <span>时长 {fmtMin(s.total_duration_s)}</span>
                        )}
                        {pace && <span>配速 {pace}</span>}
                        {hr && <span>HR {hr}</span>}
                        {rpe && <span>{rpe}</span>}
                      </div>
                      {(s.kind === 'run' || s.kind === 'strength') && (
                        <PushPlannedButton
                          session={s}
                          structuredStatus={structuredStatus}
                          canPushRun={canPushRun}
                          onPush={onPush}
                        />
                      )}
                    </div>
                  )
                })
              )}

              {dayNutrition?.kcal_target != null && (
                <p
                  data-testid="nutrition-row"
                  className="text-[11px] font-mono text-text-muted mt-auto pt-1.5 border-t border-border-subtle"
                >
                  营养 {Math.round(dayNutrition.kcal_target)} kcal
                  {dayNutrition.protein_g != null && ` · 蛋 ${Math.round(dayNutrition.protein_g)}g`}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
