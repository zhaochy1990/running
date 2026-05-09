import { useEffect } from 'react'
import type {
  PlannedSession,
  NormalizedRunWorkout,
  NormalizedStrengthWorkout,
  WorkoutStep,
} from '../types/plan'

export interface SessionDetailModalProps {
  session: PlannedSession
  onClose: () => void
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
  cross: '交叉训练',
  note: '说明',
}

const KIND_COLOR: Record<PlannedSession['kind'], string> = {
  run: '#00a85a',
  strength: '#e68a00',
  rest: '#8888a0',
  cross: '#0097a7',
  note: '#7c4dff',
}

const STEP_LABEL: Record<string, string> = {
  warmup: '热身',
  work: '训练',
  cooldown: '放松',
  recovery: '恢复',
  rest: '休息',
}

function fmtKm(m: number | null): string {
  if (m == null) return '—'
  return `${(m / 1000).toFixed(1)} km`
}

function fmtDuration(s: number | null): string {
  if (s == null) return '—'
  const total = Math.round(s)
  if (total < 60) return `${total}s`
  const min = Math.floor(total / 60)
  const sec = total % 60
  if (sec === 0) return `${min} min`
  return `${min}:${String(sec).padStart(2, '0')}`
}

function fmtPace(s: number | null | undefined): string {
  if (s == null) return '—'
  const total = Math.round(s)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}/km`
}

function stepDurationText(step: WorkoutStep): string {
  const d = step.duration
  if (d.kind === 'open' || d.value == null) return '自由'
  if (d.kind === 'distance_m') return fmtKm(d.value)
  if (d.kind === 'time_s') return fmtDuration(d.value)
  return '—'
}

function stepTargetText(step: WorkoutStep): string {
  const t = step.target
  if (t.kind === 'open') return '自由配速'
  if (t.kind === 'pace_s_km' && t.low != null && t.high != null) {
    return `${fmtPace(t.high)} – ${fmtPace(t.low)}`
  }
  if (t.kind === 'hr_bpm' && t.low != null && t.high != null) {
    return `${Math.round(t.low)}–${Math.round(t.high)} bpm`
  }
  if (t.kind === 'power_w' && t.low != null && t.high != null) {
    return `${Math.round(t.low)}–${Math.round(t.high)} W`
  }
  return '—'
}

function RunDetail({ spec }: { spec: NormalizedRunWorkout }) {
  return (
    <div className="space-y-2">
      {spec.blocks.map((block, bi) => (
        <div key={bi}>
          {block.repeat > 1 && (
            <p className="text-xs font-mono text-text-muted mb-1">
              重复 {block.repeat} 次
            </p>
          )}
          <table className="w-full text-xs font-mono" data-testid="run-steps-table">
            <thead>
              <tr className="text-text-muted border-b border-border-subtle">
                <th className="text-left py-1 pr-2 font-normal">类型</th>
                <th className="text-left py-1 pr-2 font-normal">距离/时长</th>
                <th className="text-left py-1 pr-2 font-normal">目标</th>
                <th className="text-left py-1 font-normal">备注</th>
              </tr>
            </thead>
            <tbody>
              {block.steps.map((step, si) => (
                <tr key={si} className="border-b border-border-subtle/50">
                  <td className="py-1.5 pr-2">
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px]"
                      style={{
                        color: step.step_kind === 'work' ? '#00a85a' : '#8888a0',
                        backgroundColor:
                          (step.step_kind === 'work' ? '#00a85a' : '#8888a0') + '15',
                      }}
                    >
                      {STEP_LABEL[step.step_kind] ?? step.step_kind}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2 text-text-secondary">
                    {stepDurationText(step)}
                  </td>
                  <td className="py-1.5 pr-2 text-text-primary">
                    {stepTargetText(step)}
                    {step.hr_cap_bpm != null && (
                      <span className="ml-1.5 text-text-muted">
                        HR ≤{Math.round(step.hr_cap_bpm)}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 text-text-muted">{step.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {spec.note && (
        <p className="text-xs text-text-muted mt-2">{spec.note}</p>
      )}
    </div>
  )
}

function StrengthDetail({ spec }: { spec: NormalizedStrengthWorkout }) {
  return (
    <div className="space-y-2">
      <table className="w-full text-xs font-mono" data-testid="strength-exercises-table">
        <thead>
          <tr className="text-text-muted border-b border-border-subtle">
            <th className="text-left py-1 pr-2 font-normal">#</th>
            <th className="text-left py-1 pr-2 font-normal">动作</th>
            <th className="text-left py-1 pr-2 font-normal">组×次</th>
            <th className="text-left py-1 pr-2 font-normal">组间休息</th>
            <th className="text-left py-1 font-normal">备注</th>
          </tr>
        </thead>
        <tbody>
          {spec.exercises.map((ex, i) => (
            <tr key={i} className="border-b border-border-subtle/50">
              <td className="py-1.5 pr-2 text-text-muted">{i + 1}</td>
              <td className="py-1.5 pr-2 text-text-primary">{ex.display_name}</td>
              <td className="py-1.5 pr-2 text-text-secondary">
                {ex.sets}×
                {ex.target_kind === 'reps'
                  ? `${ex.target_value}`
                  : fmtDuration(ex.target_value)}
              </td>
              <td className="py-1.5 pr-2 text-text-muted">{ex.rest_seconds}s</td>
              <td className="py-1.5 text-text-muted">{ex.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {spec.note && (
        <p className="text-xs text-text-muted mt-2">{spec.note}</p>
      )}
    </div>
  )
}

export default function SessionDetailModal({ session, onClose }: SessionDetailModalProps) {
  const s = session
  const color = KIND_COLOR[s.kind]

  // Extract RPE from summary/notes
  const haystack = `${s.summary} ${s.notes_md ?? ''}`
  const rpeMatch = /RPE\s*(\d+(?:\.\d+)?)/i.exec(haystack)

  // Escape key closes modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      data-testid="session-detail-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-detail-title"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border-subtle rounded-2xl p-5 max-w-lg w-full max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-xl" aria-hidden="true">
              {KIND_ICON[s.kind]}
            </span>
            <div>
              <span
                className="text-[11px] font-mono px-1.5 py-0.5 rounded"
                style={{ color, backgroundColor: color + '15' }}
              >
                {KIND_LABEL[s.kind]}
              </span>
              <h2 id="session-detail-title" className="text-sm font-medium text-text-primary mt-1">{s.summary}</h2>
              <p className="text-xs font-mono text-text-muted">{s.date}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary text-lg leading-none p-1"
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        {/* Overview metrics */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono text-text-secondary mb-4 pb-3 border-b border-border-subtle">
          {s.total_distance_m != null && (
            <span>距离 {fmtKm(s.total_distance_m)}</span>
          )}
          {s.total_duration_s != null && (
            <span>时长 {fmtDuration(s.total_duration_s)}</span>
          )}
          {rpeMatch && <span>RPE {rpeMatch[1]}</span>}
          {s.scheduled_workout_id != null && (
            <span className="text-accent-green">✓ 已推送</span>
          )}
        </div>

        {/* Detail section */}
        {s.spec?.schema === 'run-workout/v1' && (
          <RunDetail spec={s.spec as NormalizedRunWorkout} />
        )}
        {s.spec?.schema === 'strength-workout/v1' && (
          <StrengthDetail spec={s.spec as NormalizedStrengthWorkout} />
        )}
        {!s.spec && s.kind !== 'rest' && (
          <p className="text-xs text-text-muted">暂无详细训练结构</p>
        )}
        {s.kind === 'rest' && (
          <p className="text-xs text-text-muted">休息日 — 充分恢复</p>
        )}

        {/* Notes */}
        {s.notes_md && (
          <div className="mt-3 pt-3 border-t border-border-subtle">
            <p className="text-[11px] font-mono text-text-muted mb-1">备注</p>
            <p className="text-xs text-text-secondary whitespace-pre-wrap">{s.notes_md}</p>
          </div>
        )}
      </div>
    </div>
  )
}
