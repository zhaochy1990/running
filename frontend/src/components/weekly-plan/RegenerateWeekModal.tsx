import { useEffect, useMemo, useRef, useState } from 'react'
import {
  applyCoachWeekReplacement,
  formatDateShort,
  sendCoachChat,
  weekdayCN,
  weeklyProposalFromChat,
  type PlanDay,
  type WeekDetail,
  type WeeklyPlanCreateProposal,
} from '../../api'
import { formatSessionLoad, sessionTarget } from '../../lib/weeklyPlanView'
import type { PlannedSession } from '../../types/plan'

export interface RegenerateWeekModalProps {
  readonly folder: string
  readonly week: WeekDetail
  readonly currentDays: readonly PlanDay[]
  readonly onClose: () => void
  readonly onApplied: () => void
}

const KIND_LABEL: Record<PlannedSession['kind'], string> = {
  run: '跑步',
  strength: '力量',
  rest: '休息',
  cross: '交叉',
  note: '说明',
}

const KIND_STYLE: Record<PlannedSession['kind'], string> = {
  run: 'bg-green-soft text-accent-green',
  strength: 'bg-purple-soft text-accent-purple',
  rest: 'bg-bg-secondary text-text-muted',
  cross: 'bg-cyan-soft text-accent-cyan',
  note: 'bg-amber-soft text-accent-amber',
}

type Phase = 'input' | 'generating' | 'preview' | 'applying'

function groupByDate(
  sessions: readonly PlannedSession[],
): Map<string, PlannedSession[]> {
  const byDate = new Map<string, PlannedSession[]>()
  for (const session of sessions) {
    const list = byDate.get(session.date) ?? []
    list.push(session)
    byDate.set(session.date, list)
  }
  for (const list of byDate.values()) {
    list.sort((a, b) => a.session_index - b.session_index)
  }
  return byDate
}

export default function RegenerateWeekModal({
  folder,
  week,
  currentDays,
  onClose,
  onApplied,
}: RegenerateWeekModalProps) {
  const [request, setRequest] = useState('')
  const [phase, setPhase] = useState<Phase>('input')
  const [proposal, setProposal] = useState<WeeklyPlanCreateProposal | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sessionId = useRef(`regen-${folder}-${Date.now()}`)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && phase !== 'generating' && phase !== 'applying') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, phase])

  const proposedByDate = useMemo(
    () => groupByDate(proposal?.plan.sessions ?? []),
    [proposal],
  )

  async function generate() {
    setError(null)
    setPhase('generating')
    const trimmed = request.trim()
    const message = trimmed
      ? `重新生成本周训练计划：${trimmed}`
      : '重新生成本周训练计划'
    try {
      const res = await sendCoachChat(sessionId.current, message)
      if (!res.ok) {
        setError(`生成失败（${res.status}），请稍后重试。`)
        setPhase('input')
        return
      }
      const p = weeklyProposalFromChat(res.data)
      if (!p) {
        setError(
          res.data.clarification?.trim() ||
            res.data.reply?.trim() ||
            '未能生成新的周计划，请调整你的要求后重试。',
        )
        setPhase('input')
        return
      }
      if (p.folder !== folder) {
        setError(`生成的是 ${p.folder}，与当前查看的周不一致。请在当前周重试。`)
        setPhase('input')
        return
      }
      setProposal(p)
      setPhase('preview')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '生成失败，请稍后重试。')
      setPhase('input')
    }
  }

  async function confirm() {
    if (!proposal) return
    setError(null)
    setPhase('applying')
    try {
      const res = await applyCoachWeekReplacement(folder, proposal)
      if (!res.ok || !(res.data.replaced || res.data.created)) {
        setError(`应用失败（${res.status}），请重试。`)
        setPhase('preview')
        return
      }
      onApplied()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '应用失败，请重试。')
      setPhase('preview')
    }
  }

  const busy = phase === 'generating' || phase === 'applying'
  const showPreview = (phase === 'preview' || phase === 'applying') && proposal !== null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="重新生成本周训练计划"
      data-testid="regenerate-week-modal"
      onClick={() => {
        if (!busy) onClose()
      }}
    >
      <div
        className="w-full max-w-3xl rounded-2xl border border-border-subtle bg-bg-card shadow-xl animate-fade-in"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border-subtle p-5">
          <div>
            <p className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-accent-green">
              Coach Agent · Regenerate
            </p>
            <h2 className="mt-1 text-xl font-bold text-text-primary">重新生成本周训练计划</h2>
            <p className="mt-1 text-sm text-text-muted">
              {formatDateShort(week.date_from)} – {formatDateShort(week.date_to)} · 确认后才会替换当前这一周
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-2 py-1 text-text-muted hover:text-text-primary disabled:opacity-40"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto p-5">
          {error && (
            <div
              role="alert"
              className="mb-4 rounded-xl border border-accent-red/30 bg-red-soft p-3 text-sm text-accent-red"
            >
              {error}
            </div>
          )}

          {!showPreview && (
            <div className="space-y-3">
              <label htmlFor="regen-request" className="block text-sm font-bold text-text-primary">
                有什么特别要求？（可选）
              </label>
              <textarea
                id="regen-request"
                data-testid="regenerate-week-request"
                value={request}
                onChange={(event) => setRequest(event.target.value)}
                disabled={busy}
                rows={3}
                placeholder="例如：周三下午加一节 5K 轻松跑（当天两练）；把长距离挪到周日"
                className="w-full resize-none rounded-xl border border-border-subtle bg-bg-secondary p-3 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
              />
              <p className="text-xs text-text-muted">
                Coach 会整周重新编排（默认每天 1 节；你要求某天两练时会安排双跑），并保留本周已完成的训练。
              </p>
            </div>
          )}

          {showPreview && proposal && (
            <div className="space-y-4">
              <div className="rounded-xl border border-green-edge bg-green-soft p-3 text-sm text-text-secondary">
                {proposal.ai_explanation}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <PlanColumn
                  title="当前计划"
                  testId="regenerate-week-current"
                  days={currentDays.map((day) => ({
                    date: day.date,
                    sessions: day.sessions,
                  }))}
                />
                <PlanColumn
                  title="新计划（提案）"
                  testId="regenerate-week-proposed"
                  highlight
                  days={currentDays.map((day) => ({
                    date: day.date,
                    sessions: proposedByDate.get(day.date) ?? [],
                  }))}
                />
              </div>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-border-subtle p-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-semibold text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            取消
          </button>
          {showPreview ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setProposal(null)
                  setPhase('input')
                }}
                disabled={busy}
                className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-semibold text-text-secondary hover:text-text-primary disabled:opacity-40"
              >
                重新提要求
              </button>
              <button
                type="button"
                data-testid="regenerate-week-confirm"
                onClick={confirm}
                disabled={busy}
                className="rounded-lg bg-accent-green px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
              >
                {phase === 'applying' ? '替换中…' : '确认替换本周'}
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="regenerate-week-generate"
              onClick={generate}
              disabled={busy}
              className="rounded-lg bg-accent-green px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
            >
              {phase === 'generating' ? '生成中…' : '生成新计划'}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

interface PlanColumnProps {
  readonly title: string
  readonly testId: string
  readonly days: readonly { date: string; sessions: readonly PlannedSession[] }[]
  readonly highlight?: boolean
}

function PlanColumn({ title, testId, days, highlight = false }: PlanColumnProps) {
  return (
    <div
      data-testid={testId}
      className={`rounded-xl border p-3 ${highlight ? 'border-green-edge bg-green-soft/40' : 'border-border-subtle bg-bg-secondary'}`}
    >
      <p className="mb-2 text-xs font-bold uppercase tracking-wider text-text-muted">{title}</p>
      <div className="space-y-2">
        {days.map((day) => (
          <div key={day.date}>
            <p className="font-mono text-[11px] text-text-muted">
              {weekdayCN(day.date)} · {formatDateShort(day.date)}
            </p>
            <div className="mt-1 space-y-1.5">
              {day.sessions.length === 0 ? (
                <div className="rounded-lg bg-bg-card px-2.5 py-1.5 text-xs text-text-muted">无安排</div>
              ) : (
                day.sessions.map((session) => (
                  <SessionLine key={session.session_index} session={session} />
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SessionLine({ session }: { readonly session: PlannedSession }) {
  const target = sessionTarget(session)
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${KIND_STYLE[session.kind]}`}>
          {KIND_LABEL[session.kind]}
        </span>
        <span className="text-xs font-bold text-text-primary">{session.summary}</span>
      </div>
      <div className="mt-1 font-mono text-[10px] text-text-muted">
        {formatSessionLoad(session)}
        {target ? ` · ${target}` : ''}
      </div>
    </div>
  )
}
