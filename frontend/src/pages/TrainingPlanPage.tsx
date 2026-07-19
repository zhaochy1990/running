import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CoachPlanAppliedBanner } from '../components/CoachPlanAppliedBanner'
import {
  applyMasterPlanReviewDiff,
  confirmMasterPlan,
  getCurrentMasterPlan,
  getDraftMasterPlan,
  getMasterPlanById,
  getMyProfile,
  getTrainingGoal,
  getTrainingPlan,
  sendMasterPlanReviewMessage,
  type CompletedPhaseSummary,
  type MasterPlan,
  type MasterPlanAdjustMessage,
  type MasterPlanDiff,
  type MasterPlanDiffOp,
  type MasterPlanMilestone,
  type MasterPlanPhase,
  type MasterPlanWeek,
  type MyProfile,
  type TrainingGoal,
  type TrainingPlan,
} from '../api'
import { shanghaiToday } from '../lib/shanghai'
import { useUser } from '../UserContextValue'
import TrainingPlanSetup from './TrainingPlanSetup'
import ViewHead from '../components/ViewHead'
import WeeksGrid from '../components/WeeksGrid'

type PlanTab = 'overview' | 'weeks'

interface TargetSummary {
  raceName: string
  distance: string
  raceDate: string
  targetTime: string
}

interface PhaseSpan {
  phase: MasterPlanPhase
  index: number
  weekStart: number
  weekEnd: number
  weekCount: number
}

interface MileageBar {
  week: number
  plannedKmLow: number | null
  plannedKm: number | null
  plannedDoseLow: number | null
  plannedDoseHigh: number | null
  actualKm: number | null
  displayKm: number | null
  heightPct: number
  fillPct: number
  plannedLinePct: number | null
  phase: MasterPlanPhase
  phaseIndex: number
  weekStart: string | null
  weekEnd: string | null
  isCompleted: boolean
  actualAvgPaceSec: number | null
  actualAvgPaceFmt: string
  actualAvgHr: number | null
  actualRunCount: number
  source: 'actual' | 'planned' | 'estimated'
  isCurrent: boolean
  isRecoveryWeek: boolean
  isTaperWeek: boolean
  title: string
}

type CycleMetric = 'mileage' | 'load'

interface PhaseVisual {
  color: string
  soft: string
  edge: string
  label: string
}

const EMPTY_TARGET: TargetSummary = {
  raceName: '',
  distance: '',
  raceDate: '',
  targetTime: '',
}

const EMPTY_PHASES: MasterPlanPhase[] = []
const EMPTY_MILESTONES: MasterPlanMilestone[] = []
const EMPTY_TRAINING_PRINCIPLES: string[] = []

const PHASE_VISUALS: Record<string, PhaseVisual> = {
  base: { color: 'var(--green)', soft: 'var(--green-soft)', edge: 'var(--green-edge)', label: '基础' },
  speed: { color: 'var(--cyan)', soft: 'var(--cyan-soft)', edge: 'var(--cyan-edge)', label: '速度' },
  build: { color: 'var(--teal-deep)', soft: 'var(--cyan-soft)', edge: 'var(--cyan-edge)', label: '专项' },
  peak: { color: 'var(--amber)', soft: 'var(--amber-soft)', edge: 'var(--amber-edge)', label: '峰值' },
  taper: { color: 'var(--purple)', soft: 'var(--purple-soft)', edge: 'var(--purple-edge)', label: '减量' },
  race: { color: 'var(--red)', soft: 'var(--red-soft)', edge: 'var(--red-edge)', label: '比赛' },
  recovery: { color: 'var(--faint)', soft: 'var(--elevated)', edge: 'var(--border-subtle)', label: '恢复' },
}

const PHASE_ORDER = ['base', 'speed', 'build', 'peak', 'taper', 'race', 'recovery']

function phaseKind(phase: MasterPlanPhase, index: number): string {
  if (phase.phase_type && PHASE_VISUALS[phase.phase_type]) return phase.phase_type
  const name = phase.name
  if (/基础|Base/i.test(name)) return 'base'
  if (/速度|Speed/i.test(name)) return 'speed'
  if (/峰值|Peak/i.test(name)) return 'peak'
  if (/专项|Build/i.test(name)) return 'build'
  if (/减量|Taper/i.test(name)) return 'taper'
  if (/比赛|Race/i.test(name)) return 'race'
  if (/恢复|Recovery/i.test(name)) return 'recovery'
  return PHASE_ORDER[index % PHASE_ORDER.length]
}

function phaseVisual(phase: MasterPlanPhase, index: number): PhaseVisual {
  return PHASE_VISUALS[phaseKind(phase, index)] ?? PHASE_VISUALS.base
}

function shortPhaseName(phase: MasterPlanPhase, index: number): string {
  return `P${index + 1} ${phaseVisual(phase, index).label}`
}

function weeksBetween(start: string, end: string): number {
  const s = parseDateOnly(start)
  const e = parseDateOnly(end)
  if (!s || !e || e < s) return 1
  const days = Math.floor((e.getTime() - s.getTime()) / 86400000) + 1
  return Math.max(1, Math.ceil(days / 7))
}

function parseDateOnly(value: string): Date | null {
  const [y, m, d] = value.split('T')[0].split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

function formatShort(dateStr: string): string {
  const [, m, d] = dateStr.split('T')[0].split('-')
  if (!m || !d) return dateStr
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`
}

function formatSlashDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('T')[0].split('-')
  if (!year || !month || !day) return dateStr
  return `${year}/${month}/${day}`
}

function stringField(raw: Record<string, unknown> | null | undefined, key: string): string {
  const value = raw?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

function distanceLabel(value: string): string {
  const labels: Record<string, string> = { '5K': '5K', '10K': '10K', HM: '半马', FM: '全马', trail: '越野' }
  return labels[value] || value
}

function targetFrom(goal: TrainingGoal | null, profile: MyProfile | null, plan?: MasterPlan | null): TargetSummary {
  const rawProfile = profile?.profile ?? null
  const raceName = goal?.race_name?.trim() || plan?.goal?.race_name || stringField(rawProfile, 'target_race')
  const distance = goal?.race_distance || plan?.goal?.distance || stringField(rawProfile, 'target_distance')
  const raceDate = goal?.race_date || plan?.goal?.race_date || stringField(rawProfile, 'target_race_date')
  const targetTime = goal?.target_finish_time || plan?.goal?.target_time || stringField(rawProfile, 'target_time')
  return {
    raceName,
    distance: distanceLabel(distance),
    raceDate,
    targetTime,
  }
}

type PageState = 'loading' | 'setup' | 'review' | 'plan'

export default function TrainingPlanPage() {
  const { user, coachChat } = useUser()
  const navigate = useNavigate()
  const [masterPlan, setMasterPlan] = useState<MasterPlan | null>(null)
  const [draftPlan, setDraftPlan] = useState<MasterPlan | null>(null)
  const [fallbackPlan, setFallbackPlan] = useState<TrainingPlan | null>(null)
  const [target, setTarget] = useState<TargetSummary>(EMPTY_TARGET)
  const [pageState, setPageState] = useState<PageState>('loading')
  const [planTab, setPlanTab] = useState<PlanTab>('overview')
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(null)
  const requestKey = user || ''
  const [loadedKey, setLoadedKey] = useState('')

  const loadPlan = useCallback(() => {
    if (!user) return undefined
    let cancelled = false

    Promise.all([
      getCurrentMasterPlan().catch(() => null),
      getDraftMasterPlan().catch(() => null),
      getTrainingPlan(user).catch(() => null),
      getTrainingGoal().catch(() => null),
      getMyProfile().catch(() => null),
    ]).then(([master, draft, fallback, goal, profile]) => {
      if (cancelled) return
      setMasterPlan(master)
      setDraftPlan(draft)
      setFallbackPlan(fallback)
      setTarget(targetFrom(goal, profile, master ?? draft))
      if (master) {
        setPageState('plan')
      } else if (draft) {
        setPageState('review')
      } else if (fallback?.content) {
        setPageState('plan')
      } else {
        setPageState('setup')
      }
    }).finally(() => {
      if (!cancelled) setLoadedKey(requestKey)
    })

    return () => { cancelled = true }
  }, [user, requestKey])

  useEffect(() => {
    return loadPlan()
  }, [loadPlan])

  const loading = Boolean(requestKey && loadedKey !== requestKey)

  if (loading || pageState === 'loading') {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }

  if (pageState === 'setup') {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6 sm:px-8 sm:py-8 animate-fade-in">
        <ViewHead
          eyebrow="赛季计划 · 尚未创建"
          title="创建你的赛季计划"
          lede="设置目标赛事，AI 教练会基于你的训练史与当前体能倒推出一份周期化赛季计划"
        />
        <TrainingPlanSetup
          onDraftReady={(planId) => {
            setPageState('loading')
            getMasterPlanById(planId)
              .then((plan) => {
                setDraftPlan(plan)
                setTarget((prev) => prev.raceName ? prev : targetFrom(null, null, plan))
                setPageState('review')
              })
              .catch(() => { loadPlan() })
          }}
        />
      </div>
    )
  }

  if (pageState === 'review' && draftPlan) {
    return (
      <DraftReviewWorkspace
        plan={draftPlan}
        target={target}
        onPlanUpdated={setDraftPlan}
        onConfirmed={() => {
          setPageState('loading')
          loadPlan()
        }}
      />
    )
  }

  if (masterPlan) {
    return (
      <>
        <div className="max-w-5xl mx-auto px-4 pt-4 sm:px-8">
          <CoachPlanAppliedBanner />
        </div>
        <SeasonOverview
          plan={masterPlan}
          target={target}
          tab={planTab}
          onTab={setPlanTab}
          selectedPhaseId={selectedPhaseId}
          onSelectPhase={setSelectedPhaseId}
          onAdjust={() =>
            navigate(
              coachChat
                ? `/coach/master/${encodeURIComponent(masterPlan.plan_id)}/adjust`
                : '/plan/adjust',
            )
          }
        />
      </>
    )
  }

  if (fallbackPlan?.content) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6 sm:px-8 sm:py-8 animate-fade-in">
        <ViewHead
          eyebrow="训练计划"
          title="训练总览"
          lede={fallbackPlan.current_phase ? `当前阶段 · ${fallbackPlan.current_phase}` : '训练总纲'}
        />
        <div className="bg-bg-card border border-border-subtle rounded-2xl p-4 sm:p-6">
          <div className="prose max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{fallbackPlan.content}</ReactMarkdown>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:px-8 sm:py-8 animate-fade-in">
      <ViewHead eyebrow="训练计划" title="训练计划生成中" lede="赛季计划正在后台生成，请稍后刷新页面查看" />
    </div>
  )
}

function DraftReviewWorkspace({
  plan,
  target,
  onPlanUpdated,
  onConfirmed,
}: {
  plan: MasterPlan
  target: TargetSummary
  onPlanUpdated: (plan: MasterPlan) => void
  onConfirmed: () => void
}) {
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MasterPlanAdjustMessage[]>(() => [
    {
      role: 'assistant',
      content: '这是根据你的目标和手表数据生成的赛季计划草稿。你可以先看中间的周期、阶段和关键里程碑；觉得哪里不合适，直接告诉我。',
    },
  ])
  const [draftText, setDraftText] = useState('')
  const [sending, setSending] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [diff, setDiff] = useState<MasterPlanDiff | null>(null)
  const [selectedOpIds, setSelectedOpIds] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const text = draftText.trim()
    if (!text || sending) return
    setDraftText('')
    setChatError(null)
    const nextMessages: MasterPlanAdjustMessage[] = [...messages, { role: 'user', content: text }]
    setMessages(nextMessages)
    setSending(true)
    try {
      const response = await sendMasterPlanReviewMessage(plan.plan_id, text, messages)
      if (!response.ok) throw new Error(response.status === 503 ? 'AI 教练当前不可用，请稍后重试' : `HTTP ${response.status}`)
      const assistantMessage: MasterPlanAdjustMessage = { role: 'assistant', content: response.data.ai_response }
      setMessages([...nextMessages, assistantMessage])
      const nextDiff = response.data.diff
      setDiff(nextDiff && nextDiff.ops.length > 0 ? nextDiff : null)
      setSelectedOpIds(defaultSelectedOpIds(nextDiff))
    } catch (err) {
      setChatError(err instanceof Error ? err.message : '发送失败')
    } finally {
      setSending(false)
    }
  }

  const toggleOp = (opId: string) => {
    setSelectedOpIds((prev) => {
      const next = new Set(prev)
      if (next.has(opId)) next.delete(opId)
      else next.add(opId)
      return next
    })
  }

  const applyDiff = async () => {
    if (!diff?.diff_id || applying) return
    const opIds = diff.ops.map((op) => op.id).filter((id) => selectedOpIds.has(id))
    if (opIds.length === 0) return
    setApplying(true)
    setChatError(null)
    try {
      const response = await applyMasterPlanReviewDiff(plan.plan_id, diff, opIds, diff.ai_explanation || 'review feedback')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if ((response.data.applied ?? 0) <= 0) {
        throw new Error('没有调整被采用，请确认至少选择一项可应用调整')
      }
      const updated = await getMasterPlanById(plan.plan_id)
      onPlanUpdated(updated)
      setDiff(null)
      setSelectedOpIds(new Set())
      setMessages((prev) => [...prev, { role: 'assistant', content: `已采用 ${response.data.applied} 项调整，计划预览已更新。` }])
    } catch (err) {
      setChatError(err instanceof Error ? err.message : '采用调整失败')
    } finally {
      setApplying(false)
    }
  }

  const confirmPlan = async () => {
    if (confirming) return
    setConfirming(true)
    setConfirmError(null)
    try {
      const response = await confirmMasterPlan(plan.plan_id)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      onConfirmed()
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : '启用计划失败')
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div className="grid min-h-full grid-cols-1 bg-bg-primary lg:grid-cols-[minmax(0,1fr)_360px]">
      <main className="min-w-0 px-4 py-6 sm:px-8 sm:py-8">
        <section className="mx-auto max-w-5xl">
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-green mb-2">
                赛季计划 · 待审阅
              </p>
              <h1 className="text-[28px] font-semibold leading-tight text-text-primary">审阅你的赛季训练计划</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
                这份计划仍是草稿。确认启用前，可以让 Coach 根据你的反馈调整阶段、周量或里程碑。
              </p>
            </div>
            <button
              type="button"
              onClick={confirmPlan}
              disabled={confirming}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-accent-green px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent-green-dim disabled:cursor-not-allowed disabled:opacity-55"
            >
              <CheckIcon />
              {confirming ? '启用中...' : '启用计划'}
            </button>
          </div>
          {confirmError && (
            <div className="mb-4 rounded-lg border border-accent-red/30 bg-accent-red/5 px-4 py-3 text-sm text-accent-red">
              {confirmError}
            </div>
          )}
          <SeasonOverviewBody
            plan={plan}
            target={target}
            selectedPhaseId={selectedPhaseId}
            onSelectPhase={setSelectedPhaseId}
          />
        </section>
      </main>

      <ReviewChatPanel
        messages={messages}
        input={draftText}
        onInput={setDraftText}
        onSubmit={handleSubmit}
        sending={sending}
        error={chatError}
        diff={diff}
        selectedOpIds={selectedOpIds}
        onToggleOp={toggleOp}
        onApply={applyDiff}
        applying={applying}
        onConfirm={confirmPlan}
        confirming={confirming}
      />
    </div>
  )
}

function ReviewChatPanel({
  messages,
  input,
  onInput,
  onSubmit,
  sending,
  error,
  diff,
  selectedOpIds,
  onToggleOp,
  onApply,
  applying,
  onConfirm,
  confirming,
}: {
  messages: MasterPlanAdjustMessage[]
  input: string
  onInput: (value: string) => void
  onSubmit: (event: FormEvent) => void
  sending: boolean
  error: string | null
  diff: MasterPlanDiff | null
  selectedOpIds: Set<string>
  onToggleOp: (opId: string) => void
  onApply: () => void
  applying: boolean
  onConfirm: () => void
  confirming: boolean
}) {
  const acceptedCount = diff?.ops.filter((op) => selectedOpIds.has(op.id)).length ?? 0
  return (
    <aside className="flex min-h-[620px] flex-col border-l border-border-subtle bg-bg-card lg:sticky lg:top-0 lg:h-screen">
      <div className="flex h-[50px] shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-green text-white font-mono text-xs font-bold">S</span>
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-text-primary">和 Coach 审阅计划</span>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className={`flex gap-2 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[88%] rounded-lg border px-3 py-2 text-sm leading-6 ${
              message.role === 'user'
                ? 'border-border-subtle bg-bg-primary text-text-primary'
                : 'border-border-subtle bg-bg-secondary text-text-primary'
            }`}>
              {message.content}
            </div>
          </div>
        ))}

        {diff && diff.ops.length > 0 && (
          <div className="rounded-lg border border-border-subtle bg-bg-primary p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-text-primary">Coach 调整建议</h3>
              <span className="font-mono text-[11px] text-text-muted">{acceptedCount}/{diff.ops.length}</span>
            </div>
            {diff.ai_explanation && <p className="mb-3 text-xs leading-5 text-text-secondary">{diff.ai_explanation}</p>}
            <div className="space-y-2">
              {diff.ops.map((op) => (
                <ReviewDiffOpRow
                  key={op.id}
                  op={op}
                  checked={selectedOpIds.has(op.id)}
                  onToggle={() => onToggleOp(op.id)}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={onApply}
              disabled={applying || selectedOpIds.size === 0}
              className="mt-3 inline-flex h-8 w-full items-center justify-center gap-2 rounded-md bg-accent-green px-3 text-xs font-semibold text-white transition-colors hover:bg-accent-green-dim disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CheckIcon />
              {applying ? '采用中...' : '采用选中调整'}
            </button>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-accent-red/30 bg-accent-red/5 p-3 text-xs text-accent-red">
            {error}
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-3 border-t border-border-subtle bg-bg-card px-4 py-4">
        <div className="flex items-center gap-3 rounded-lg border border-green-edge bg-green-soft p-3">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">准备好训练了吗？</p>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming}
            className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-accent-green px-3 text-xs font-semibold text-white hover:bg-accent-green-dim disabled:opacity-50"
          >
            <CheckIcon />
            启用计划
          </button>
        </div>
        <form onSubmit={onSubmit} className="relative">
          <input
            value={input}
            onChange={(event) => onInput(event.target.value)}
            disabled={sending}
            placeholder="告诉 Coach 你想调整哪里..."
            className="h-10 w-full rounded-lg border border-border-subtle bg-bg-primary px-3 pr-12 text-sm text-text-primary outline-none transition-colors focus:border-accent-green focus:ring-1 focus:ring-accent-green disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            title="提交反馈"
            className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-accent-green transition-colors hover:bg-accent-green/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SendIcon />
          </button>
        </form>
      </div>
    </aside>
  )
}

function ReviewDiffOpRow({ op, checked, onToggle }: { op: MasterPlanDiffOp; checked: boolean; onToggle: () => void }) {
  const disabled = op.accepted === false
  return (
    <label className={`flex items-start gap-2 rounded-md border border-border-subtle bg-bg-card p-2.5 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} className="mt-1 accent-accent-green" />
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-text-primary">{diffOpLabel(op.op)}</span>
        <span className="mt-0.5 block break-words text-[11px] leading-5 text-text-muted">{summarizeDiffValue(op)}</span>
      </span>
    </label>
  )
}

function SeasonOverviewBody({
  plan,
  target,
  selectedPhaseId,
  onSelectPhase,
}: {
  plan: MasterPlan
  target: TargetSummary
  selectedPhaseId: string | null
  onSelectPhase: (id: string) => void
}) {
  const today = shanghaiToday()
  const phases = plan.phases ?? EMPTY_PHASES
  const milestones = plan.milestones ?? EMPTY_MILESTONES
  const trainingPrinciples = plan.training_principles ?? EMPTY_TRAINING_PRINCIPLES
  const spans = useMemo(() => buildPhaseSpans(phases, plan.total_weeks), [phases, plan.total_weeks])
  const totalWeeks = plan.total_weeks ?? spans.at(-1)?.weekEnd ?? weeksBetween(plan.start_date, plan.end_date)
  const currentWeek = plan.current_week_number ?? currentWeekNumber(plan.start_date, today, totalWeeks)
  const currentPhaseId = plan.current_phase_id ?? findPhaseForDate(phases, today)?.id ?? phases[0]?.id ?? null
  const activePhaseId = selectedPhaseId ?? currentPhaseId
  const activeSpan = spans.find((span) => span.phase.id === activePhaseId) ?? spans[0] ?? null
  const currentSpan = spans.find((span) => span.phase.id === currentPhaseId) ?? activeSpan
  const nextMilestone = selectNextMilestone(plan, today)

  return (
    <div className="space-y-6">
      {spans.length > 0 && (
        <MileageCycleCard
          plan={plan}
          spans={spans}
          totalWeeks={totalWeeks}
          currentWeek={currentWeek}
          onSelectPhase={onSelectPhase}
        />
      )}

      {spans.length > 0 && (
        <PhasePills
          spans={spans}
          activePhaseId={activeSpan?.phase.id ?? null}
          currentPhaseId={currentPhaseId}
          onSelectPhase={onSelectPhase}
        />
      )}

      <SummaryCards
        plan={plan}
        target={target}
        currentWeek={currentWeek}
        currentPhase={currentSpan?.phase ?? null}
        nextMilestone={nextMilestone}
      />

      {activeSpan && (
        <PhaseDetail
          phase={activeSpan.phase}
          index={activeSpan.index}
          span={activeSpan}
          milestones={milestones.filter((milestone) => milestone.phase_id === activeSpan.phase.id)}
        />
      )}

      {trainingPrinciples.length > 0 && (
        <TrainingPrinciples principles={trainingPrinciples} />
      )}
    </div>
  )
}

function SeasonOverview({
  plan,
  target,
  tab,
  onTab,
  selectedPhaseId,
  onSelectPhase,
  onAdjust,
}: {
  plan: MasterPlan
  target: TargetSummary
  tab: PlanTab
  onTab: (tab: PlanTab) => void
  selectedPhaseId: string | null
  onSelectPhase: (id: string) => void
  onAdjust: () => void
}) {
  const today = shanghaiToday()
  const phases = plan.phases ?? EMPTY_PHASES
  const spans = useMemo(() => buildPhaseSpans(phases, plan.total_weeks), [phases, plan.total_weeks])
  const totalWeeks = plan.total_weeks ?? spans.at(-1)?.weekEnd ?? weeksBetween(plan.start_date, plan.end_date)
  const currentWeek = plan.current_week_number ?? currentWeekNumber(plan.start_date, today, totalWeeks)
  const currentPhaseId = plan.current_phase_id ?? findPhaseForDate(phases, today)?.id ?? phases[0]?.id ?? null
  const currentSpan = spans.find((span) => span.phase.id === currentPhaseId) ?? spans[0] ?? null
  const heroTitle = target.raceName || '赛季训练计划'
  const heroLede = buildHeroLede(plan, target, currentSpan?.phase ?? null, totalWeeks, currentWeek)

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-8 sm:py-8 animate-fade-in">
      <section className="mb-6 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-semibold tracking-[0.14em] text-text-muted uppercase mb-2">
            赛季训练计划 · {plan.status === 'active' ? '已启用' : plan.status}
          </p>
          <h1 className="text-[28px] sm:text-[32px] font-semibold leading-[1.1] text-text-primary break-words">
            {heroTitle}
          </h1>
          <p className="mt-3 max-w-[920px] text-sm leading-6 text-text-secondary">
            {heroLede}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <button
            type="button"
            disabled
            title="版本历史暂未开放"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border-subtle bg-bg-card px-4 text-sm font-semibold text-text-secondary opacity-70"
          >
            <HistoryIcon />
            版本历史
          </button>
          <button
            type="button"
            onClick={onAdjust}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent-green px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent-green-dim"
          >
            <RefreshIcon />
            调整计划
          </button>
        </div>
      </section>

      <div className="mb-6 flex flex-wrap gap-2">
        <PlanTabButton active={tab === 'overview'} onClick={() => onTab('overview')}>赛季总览</PlanTabButton>
        <PlanTabButton active={tab === 'weeks'} onClick={() => onTab('weeks')}>训练周列表</PlanTabButton>
      </div>

      {tab === 'weeks' ? (
        <WeeksGrid />
      ) : (
        <SeasonOverviewBody
          plan={plan}
          target={target}
          selectedPhaseId={selectedPhaseId}
          onSelectPhase={onSelectPhase}
        />
      )}
    </div>
  )
}

function PlanTabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ${
        active
          ? 'border-border-subtle bg-bg-card text-text-primary shadow-sm'
          : 'border-transparent bg-transparent text-text-muted hover:border-border-subtle hover:bg-bg-card hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}

function MileageCycleCard({
  plan,
  spans,
  totalWeeks,
  currentWeek,
  onSelectPhase,
}: {
  plan: MasterPlan
  spans: PhaseSpan[]
  totalWeeks: number
  currentWeek: number
  onSelectPhase: (id: string) => void
}) {
  const [metric, setMetric] = useState<CycleMetric>('mileage')
  const bars = useMemo(() => buildMileageBars(plan, spans, totalWeeks, currentWeek), [plan, spans, totalWeeks, currentWeek])
  const columns = Math.max(bars.length, 1)
  const loadAvailable = plan.training_load_projection?.status === 'available'
    && bars.some((bar) => bar.plannedDoseLow != null && bar.plannedDoseHigh != null)
  const activeMetric: CycleMetric = metric === 'load' && loadAvailable ? 'load' : 'mileage'
  const maxDose = Math.max(...bars.map((bar) => bar.plannedDoseHigh ?? 0), 1)

  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <h2 className="text-lg font-semibold text-text-primary">训练周期</h2>
        <div className="inline-flex rounded-lg border border-border-subtle bg-bg-secondary p-0.5" aria-label="训练周期指标">
          <CycleMetricButton active={activeMetric === 'mileage'} onClick={() => setMetric('mileage')}>跑量</CycleMetricButton>
          <CycleMetricButton active={activeMetric === 'load'} disabled={!loadAvailable} onClick={() => setMetric('load')}>负荷</CycleMetricButton>
        </div>
      </div>
      <div className="px-5 py-5 sm:px-6">
        <p className="mb-4 font-mono text-[10px] font-semibold tracking-[0.14em] text-text-muted uppercase">
          {activeMetric === 'load' ? '预计周负荷（STRIDE DOSE）' : '周跑量（KM/周）'}
        </p>
        <div
          className="grid h-40 items-end gap-1.5"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {bars.map((bar) => {
            const visual = phaseVisual(bar.phase, bar.phaseIndex)
            const hasLoadRange = bar.plannedDoseLow != null && bar.plannedDoseHigh != null
            const loadHighPct = hasLoadRange
              ? Math.max(8, Math.round((bar.plannedDoseHigh! / maxDose) * 100))
              : 0
            const loadLowPct = bar.plannedDoseHigh && bar.plannedDoseLow != null
              ? Math.max(0, Math.min(100, Math.round((bar.plannedDoseLow / bar.plannedDoseHigh) * 100)))
              : 0
            return (
              <button
                key={bar.week}
                type="button"
                title={bar.title}
                aria-label={bar.title}
                onClick={() => onSelectPhase(bar.phase.id)}
                className={`group relative rounded-t border border-transparent transition-all hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-green focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary ${activeMetric === 'load' && !hasLoadRange ? 'min-h-0' : 'min-h-[10px]'} ${bar.isCurrent ? 'ring-2 ring-accent-green ring-offset-2 ring-offset-bg-primary' : ''}`}
                style={{
                  height: activeMetric === 'load' ? loadHighPct + '%' : bar.heightPct + '%',
                  backgroundColor: `color-mix(in oklab, ${visual.color} 12%, var(--surface))`,
                  borderColor: bar.isCompleted ? `color-mix(in oklab, ${visual.color} 38%, transparent)` : 'transparent',
                }}
              >
                <span
                  className="absolute inset-x-0 bottom-0 rounded-t"
                  style={{
                    height: activeMetric === 'load' ? loadLowPct + '%' : bar.fillPct + '%',
                    backgroundColor: activeMetric === 'load' ? visual.color : mileageBarFillColor(bar, visual),
                  }}
                  aria-hidden="true"
                />
                {activeMetric === 'mileage' && bar.plannedLinePct != null && (
                  <span
                    className="pointer-events-none absolute left-0 right-0 border-t-2 border-dashed border-text-primary/80"
                    style={{ bottom: `${bar.plannedLinePct}%` }}
                    aria-hidden="true"
                  />
                )}
                {bar.isCurrent && (
                  <span className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] font-semibold text-accent-green">
                    W{padWeek(bar.week)} 当前
                  </span>
                )}
                <MileageTooltip bar={bar} />
              </button>
            )
          })}
        </div>
        {activeMetric === 'load' ? (
          <div className="mt-3 space-y-2 font-mono text-[10px] text-text-muted">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm bg-accent-green" />负荷区间下限</span>
              <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm border border-accent-green/30 bg-accent-green/15" />至负荷区间上限</span>
            </div>
            <p>STRIDE dose 是根据计划跑量与关键课估算的每周负荷区间。</p>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[10px] text-text-muted">
            <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm bg-accent-green" />已完成周实际跑量</span>
            <span className="inline-flex items-center gap-2"><span className="h-0 w-4 border-t-2 border-dashed border-text-primary/70" />计划跑量标记</span>
          </div>
        )}
        {!loadAvailable && (
          <p className="mt-3 rounded border border-border-subtle bg-bg-secondary px-3 py-2 text-xs text-text-muted">
            该计划尚无可用的周负荷数据
          </p>
        )}
        <div
          className="mt-3 grid font-mono text-[10px] text-text-muted"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {spans.map((span) => (
            <div
              key={span.phase.id}
              className="min-w-0 text-left"
              style={{ gridColumn: `${span.weekStart} / span ${Math.max(1, Math.min(span.weekCount, 3))}` }}
            >
              <span>{formatShort(span.phase.start_date)}</span>
              <br />
              <span className="font-sans text-[11px] text-text-secondary">{shortPhaseName(span.phase, span.index)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function CycleMetricButton({ active, disabled = false, onClick, children }: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  const classes = active
    ? 'border border-green-edge bg-green-soft text-accent-green'
    : 'border border-transparent text-text-muted hover:text-text-primary'
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={'rounded-md px-3 py-1.5 font-mono text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ' + classes}
    >
      {children}
    </button>
  )
}

function MileageTooltip({ bar }: { bar: MileageBar }) {
  return (
    <span className="pointer-events-none absolute left-1/2 bottom-[calc(100%+12px)] z-20 hidden w-52 -translate-x-1/2 rounded-md border border-border-subtle bg-bg-card p-3 text-left shadow-lg group-hover:block group-focus-visible:block">
      <span className="mb-2 block font-mono text-[10px] font-semibold text-text-primary">
        W{padWeek(bar.week)}{bar.weekStart ? ` · ${formatShort(bar.weekStart)}` : ''}
      </span>
      <span className="grid gap-1.5 font-mono text-[10px] leading-4 text-text-secondary">
        <span className="flex justify-between gap-3"><span>计划跑量</span><span className="text-text-primary">{formatRange(bar.plannedKmLow, bar.plannedKm, 'km')}</span></span>
        <span className="flex justify-between gap-3"><span>计划负荷</span><span className="text-text-primary">{formatRange(bar.plannedDoseLow, bar.plannedDoseHigh, 'dose')}</span></span>
        <span className="flex justify-between gap-3"><span>实际跑量</span><span className="text-text-primary">{bar.isCompleted ? formatKm(bar.actualKm ?? 0) : '未完成'}</span></span>
        <span className="flex justify-between gap-3"><span>实际均配</span><span className="text-text-primary">{bar.isCompleted ? formatPace(bar) : '--'}</span></span>
        <span className="flex justify-between gap-3"><span>实际均心率</span><span className="text-text-primary">{bar.isCompleted ? formatHr(bar) : '--'}</span></span>
      </span>
    </span>
  )
}

function PhasePills({
  spans,
  activePhaseId,
  currentPhaseId,
  onSelectPhase,
}: {
  spans: PhaseSpan[]
  activePhaseId: string | null
  currentPhaseId: string | null
  onSelectPhase: (id: string) => void
}) {
  return (
    <section className="flex flex-wrap gap-2">
      {spans.map((span) => {
        const active = span.phase.id === activePhaseId
        const visual = phaseVisual(span.phase, span.index)
        const suffix = span.phase.is_completed ? '（已完成）' : span.phase.id === currentPhaseId ? '（当前）' : ''
        return (
          <button
            key={span.phase.id}
            type="button"
            onClick={() => onSelectPhase(span.phase.id)}
            className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[11px] font-semibold leading-none transition-colors hover:bg-bg-card-hover"
            style={{
              borderColor: active ? visual.edge : 'var(--border-subtle)',
              backgroundColor: active ? visual.soft : 'var(--surface)',
              color: active ? visual.color : 'var(--muted)',
            }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: visual.color }} />
            {span.phase.name}{suffix} · {span.weekCount}周
          </button>
        )
      })}
    </section>
  )
}

function SummaryCards({
  plan,
  target,
  currentWeek,
  currentPhase,
  nextMilestone,
}: {
  plan: MasterPlan
  target: TargetSummary
  currentWeek: number
  currentPhase: MasterPlanPhase | null
  nextMilestone: MasterPlanMilestone | null
}) {
  const targetMeta = [target.raceDate && formatSlashDate(target.raceDate), target.distance].filter(Boolean).join(' · ')
  return (
    <section className="grid grid-cols-1 gap-4 md:grid-cols-4">
      <MetricCard label="当前周" value={`W${padWeek(currentWeek)}`} detail={currentPhase?.name ?? '暂无当前阶段'} />
      <MetricCard label="目标赛事" value={target.raceName || '尚未设置'} detail={targetMeta || `${formatSlashDate(plan.end_date)} 前完成赛季计划`} />
      <MetricCard label="目标成绩" value={target.targetTime || '完赛'} detail="Asia/Shanghai" />
      <MetricCard
        label="下一里程碑"
        value={nextMilestone ? formatSlashDate(nextMilestone.date) : '暂无'}
        detail={nextMilestone?.target ?? '当前阶段暂无关键里程碑'}
      />
    </section>
  )
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card p-4">
      <p className="mb-1 font-mono text-[10px] font-semibold tracking-[0.12em] text-text-muted uppercase">{label}</p>
      <p className="truncate text-xl font-bold leading-tight text-text-primary md:text-[22px]">{value}</p>
      <p className="mt-2 line-clamp-3 text-sm leading-5 text-text-secondary">{detail}</p>
    </div>
  )
}

function PhaseDetail({
  phase,
  index,
  span,
  milestones,
}: {
  phase: MasterPlanPhase
  index: number
  span: PhaseSpan
  milestones: MasterPlanMilestone[]
}) {
  const visual = phaseVisual(phase, index)
  const triggers = phase.monitoring_triggers ?? []
  const keySessionTypes = phase.key_session_types ?? []
  const band = formatDistanceBand(phase)
  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-bg-card">
      <div
        className="flex flex-col gap-3 border-b border-border-subtle px-5 py-4 sm:flex-row sm:items-center"
        style={{ backgroundColor: `color-mix(in oklab, ${visual.soft} 54%, var(--surface))` }}
      >
        <span className="h-3 w-3 rounded-full" style={{ backgroundColor: visual.color }} />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-text-primary">{phase.name}</h2>
          <p className="mt-1 font-mono text-[10px] text-text-muted">
            {formatSlashDate(phase.start_date)} - {formatSlashDate(phase.end_date)} · {phase.phase_type ?? phaseKind(phase, index)}{phase.is_completed ? ' · 已完成' : ''}
          </p>
        </div>
        <span className="font-mono text-xs font-semibold text-text-secondary">{band}</span>
      </div>

      <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <article className="min-w-0 space-y-5">
          <PhaseTextBlock title="阶段重点" body={phase.focus || '暂无阶段重点'} />
          {phase.rhythm && <PhaseTextBlock title="阶段节奏" body={phase.rhythm} />}
          {phase.key_workouts && <PhaseTextBlock title="关键课" body={phase.key_workouts} />}
          <div>
            <h3 className="mb-2 text-[16px] font-bold text-text-primary">监控触发</h3>
            {triggers.length > 0 ? (
              <ul className="space-y-2 text-sm leading-6 text-text-primary">
                {triggers.map((trigger) => (
                  <li key={trigger} className="flex gap-2">
                    <RadioCheckIcon color={visual.color} />
                    <span>{trigger}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-muted">暂无监控触发</p>
            )}
          </div>
          {phase.coach_note && (
            <blockquote
              className="rounded border p-4 font-editorial text-base italic leading-7 text-text-primary"
              style={{ borderColor: visual.edge, backgroundColor: visual.soft }}
            >
              <h3 className="mb-2 font-sans text-[16px] font-bold not-italic" style={{ color: visual.color }}>Coach Note</h3>
              {phase.coach_note}
            </blockquote>
          )}
          {phase.is_completed && phase.summary && (
            <CompletedPhaseResults summary={phase.summary} visual={visual} />
          )}
        </article>

        <aside className="space-y-4">
          <SideBlock title="关键课型">
            {keySessionTypes.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {keySessionTypes.map((session) => (
                  <span key={session} className="rounded border border-border-subtle bg-bg-elevated px-2 py-1 font-mono text-[10px] text-text-secondary">
                    {session}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-text-muted">无关键课型</p>
            )}
          </SideBlock>

          <SideBlock title="周里程区间">
            <p className="text-[28px] font-bold text-text-primary">
              {formatDistanceValue(phase)}<span className="text-sm font-normal text-text-secondary"> km/w</span>
            </p>
            <p className="mt-1 text-sm text-text-muted">W{padWeek(span.weekStart)}-W{padWeek(span.weekEnd)} · {formatShort(phase.start_date)} - {formatShort(phase.end_date)}</p>
          </SideBlock>

          <SideBlock title="关键里程碑">
            {milestones.length > 0 ? (
              <div className="space-y-3">
                {milestones.map((milestone) => (
                  <div key={milestone.id} className="rounded border border-border-subtle bg-bg-elevated p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="font-mono text-xs font-semibold" style={{ color: visual.color }}>{formatSlashDate(milestone.date)}</span>
                      <span className="font-mono text-[10px] text-text-muted">{milestone.type}</span>
                    </div>
                    <p className="text-sm leading-6 text-text-primary">{milestone.completed_actual || milestone.target}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-text-muted">暂无关键里程碑</p>
            )}
          </SideBlock>
        </aside>
      </div>
    </section>
  )
}

function PhaseTextBlock({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h3 className="mb-2 text-[16px] font-bold text-text-primary">{title}</h3>
      <p className="text-[15px] leading-7 text-text-primary">{body}</p>
    </div>
  )
}

function SideBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-border-subtle bg-bg-secondary p-4">
      <p className="mb-3 font-mono text-[10px] font-semibold tracking-[0.12em] text-text-muted uppercase">{title}</p>
      {children}
    </div>
  )
}

function CompletedPhaseResults({ summary, visual }: { summary: CompletedPhaseSummary; visual: PhaseVisual }) {
  const zones = summary.hr_zone_distribution ?? []
  const stats = [
    { label: '总跑量', value: `${summary.total_distance_km} km` },
    { label: '跑步次数', value: `${summary.run_count}` },
    { label: '均配', value: summary.avg_pace_fmt ? `${summary.avg_pace_fmt}/km` : '暂无' },
    { label: '均心率', value: summary.avg_hr != null ? `${summary.avg_hr} bpm` : '暂无' },
  ]
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded border border-border-subtle bg-bg-secondary p-3">
            <p className="mb-1 font-mono text-[10px] text-text-muted">{stat.label}</p>
            <p className="font-bold text-text-primary">{stat.value}</p>
          </div>
        ))}
      </div>
      {zones.length > 0 && (
        <div className="rounded border border-border-subtle bg-bg-secondary p-3">
          <p className="mb-2 font-mono text-[10px] text-text-muted">心率区间分布</p>
          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {zones.map((zone) => (
              <div key={zone.zone_index} className="flex justify-between gap-3 text-xs text-text-secondary">
                <span style={{ color: visual.color }}>Z{zone.zone_index}</span>
                <span>{zone.percent}% · {zone.minutes}min</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function TrainingPrinciples({ principles }: { principles: string[] }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-bg-card">
      <div className="border-b border-border-subtle px-5 py-4">
        <h2 className="text-lg font-semibold text-text-primary">训练原则</h2>
      </div>
      <ol className="space-y-3 p-5 sm:p-6">
        {principles.map((principle, index) => (
          <li key={`${index}-${principle}`} className="flex gap-3">
            <span className="mt-1 font-mono text-xs font-semibold text-accent-green">{padWeek(index + 1)}</span>
            <span className="text-[15px] leading-7 text-text-primary">{principle}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function buildPhaseSpans(phases: MasterPlanPhase[], totalWeeks: number | null): PhaseSpan[] {
  let cursor = 1
  const spans = phases.map((phase, index) => {
    const weekCount = weeksBetween(phase.start_date, phase.end_date)
    const span = {
      phase,
      index,
      weekStart: cursor,
      weekEnd: cursor + weekCount - 1,
      weekCount,
    }
    cursor = span.weekEnd + 1
    return span
  })
  if (totalWeeks && spans.length > 0 && spans[spans.length - 1].weekEnd !== totalWeeks) {
    const last = spans[spans.length - 1]
    last.weekEnd = totalWeeks
    last.weekCount = Math.max(1, last.weekEnd - last.weekStart + 1)
  }
  return spans
}

function buildMileageBars(plan: MasterPlan, spans: PhaseSpan[], totalWeeks: number, currentWeek: number): MileageBar[] {
  if (!spans[0]) return []
  const weeklyTargets = masterPlanWeeksByIndex(plan)
  const raw = spans.flatMap((span) => Array.from({ length: span.weekCount }, (_, localIndex) => {
    const week = span.weekStart + localIndex
    const target = weeklyTargets.get(week)
    const targetPhase = target ? phaseForWeekTarget(target, spans) : null
    const phase = targetPhase?.phase ?? span.phase
    const phaseIndex = targetPhase?.index ?? span.index
    const plannedKmLow = target
      ? numberOrNull(target.target_weekly_km_low ?? target.target_weekly_km_high)
      : null
    const plannedKm = target
      ? numberOrNull(target.planned_distance_km ?? target.target_weekly_km_high ?? target.target_weekly_km_low)
      : span.phase.is_completed
        ? null
        : interpolateWeeklyKm(span.phase, localIndex, span.weekCount)
    const actualKm = numberOrNull(target?.actual_distance_km)
    const isCompleted = Boolean(target?.is_completed) || actualKm != null
    return {
      week,
      plannedKmLow,
      plannedKm,
      plannedDoseLow: numberOrNull(target?.target_training_dose_low),
      plannedDoseHigh: numberOrNull(target?.target_training_dose_high),
      actualKm,
      displayKm: isCompleted ? (actualKm ?? 0) : plannedKm,
      phase,
      phaseIndex,
      weekStart: target?.week_start ?? null,
      weekEnd: target?.week_end ?? null,
      isCompleted,
      actualAvgPaceSec: numberOrNull(target?.actual_avg_pace_s_km),
      actualAvgPaceFmt: target?.actual_avg_pace_fmt ?? '',
      actualAvgHr: numberOrNull(target?.actual_avg_hr),
      actualRunCount: target?.actual_run_count ?? 0,
      source: isCompleted ? 'actual' as const : target ? 'planned' as const : 'estimated' as const,
      isRecoveryWeek: Boolean(target?.is_recovery_week),
      isTaperWeek: Boolean(target?.is_taper_week),
    }
  })).filter((bar) => !totalWeeks || bar.week <= totalWeeks)
  const maxKm = Math.max(...raw.flatMap((bar) => [bar.plannedKm ?? 0, bar.displayKm ?? 0]), 1)
  return raw.map((bar) => {
    const scaleKm = Math.max(bar.plannedKm ?? 0, bar.displayKm ?? 0)
    const heightPct = Math.max(8, Math.round((scaleKm / maxKm) * 100))
    const fillPct = bar.displayKm == null ? 100 : Math.round((bar.displayKm / Math.max(scaleKm, 1)) * 100)
    const plannedLinePct = bar.isCompleted && bar.plannedKm != null
      ? Math.round((bar.plannedKm / Math.max(scaleKm, 1)) * 100)
      : null
    return {
      ...bar,
      heightPct,
      fillPct: Math.max(bar.isCompleted ? 0 : 8, Math.min(100, fillPct)),
      plannedLinePct,
      isCurrent: bar.week === currentWeek,
      title: mileageBarTitle(bar),
    }
  })
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function masterPlanWeeksByIndex(plan: MasterPlan): Map<number, MasterPlanWeek> {
  const weeks = (plan.weeks && plan.weeks.length > 0) ? plan.weeks : (plan.weekly_key_sessions ?? [])
  const out = new Map<number, MasterPlanWeek>()
  for (const week of weeks) {
    if (Number.isFinite(week.week_index)) out.set(week.week_index, week)
  }
  return out
}

function phaseForWeekTarget(week: MasterPlanWeek, spans: PhaseSpan[]): PhaseSpan | null {
  return spans.find((span) => span.phase.id === week.phase_id)
    ?? spans.find((span) => week.week_index >= span.weekStart && week.week_index <= span.weekEnd)
    ?? null
}

function mileageBarTitle(bar: Omit<MileageBar, 'heightPct' | 'fillPct' | 'plannedLinePct' | 'isCurrent' | 'title'>): string {
  const sourceLabel = bar.source === 'actual' ? '实际' : bar.source === 'planned' ? '计划' : '估算'
  const value = bar.source === 'actual' ? formatKm(bar.actualKm ?? 0) : formatKm(bar.plannedKm)
  const labels = []
  if (bar.isRecoveryWeek) labels.push('调整周')
  if (bar.isTaperWeek) labels.push('减量周')
  const suffix = labels.length > 0 ? ` · ${labels.join(' · ')}` : ''
  const planned = bar.source === 'actual' ? ` · 计划 ${formatKm(bar.plannedKm)}` : ''
  return `W${padWeek(bar.week)} ${sourceLabel} ${value}${planned} · ${bar.phase.name}${suffix}`
}

function mileageBarFillColor(bar: MileageBar, visual: PhaseVisual): string {
  if (bar.isCurrent) return visual.color
  if (bar.isCompleted) return visual.color
  if (bar.isRecoveryWeek) return `color-mix(in oklab, ${visual.color} 28%, var(--surface))`
  if (bar.isTaperWeek) return `color-mix(in oklab, ${visual.color} 34%, var(--surface))`
  return `color-mix(in oklab, ${visual.color} 42%, var(--surface))`
}

function interpolateWeeklyKm(phase: MasterPlanPhase, localIndex: number, weekCount: number): number | null {
  const low = phase.weekly_distance_km_low
  const high = phase.weekly_distance_km_high
  if (low == null && high == null) return null
  if (low == null || high == null) return Math.round(low ?? high ?? 0)
  if (weekCount <= 1) return Math.round(high)
  const ratio = localIndex / (weekCount - 1)
  return Math.round(low + ((high - low) * ratio))
}

function currentWeekNumber(startDate: string, today: string, totalWeeks: number): number {
  const start = parseDateOnly(startDate)
  const current = parseDateOnly(today)
  if (!start || !current) return 1
  const raw = Math.floor((current.getTime() - start.getTime()) / 604800000) + 1
  return Math.max(1, Math.min(totalWeeks || raw, raw))
}

function findPhaseForDate(phases: MasterPlanPhase[], today: string): MasterPlanPhase | null {
  const current = parseDateOnly(today)
  if (!current) return null
  return phases.find((phase) => {
    const start = parseDateOnly(phase.start_date)
    const end = parseDateOnly(phase.end_date)
    return Boolean(start && end && start <= current && end >= current)
  }) ?? null
}

function selectNextMilestone(plan: MasterPlan, today: string): MasterPlanMilestone | null {
  if (plan.next_milestone) {
    return {
      id: plan.next_milestone.id,
      date: plan.next_milestone.date,
      target: plan.next_milestone.target,
      type: 'next',
      phase_id: '',
      completed_actual: null,
    }
  }
  const sorted = [...(plan.milestones ?? [])].sort((a, b) => a.date.localeCompare(b.date))
  return sorted.find((milestone) => milestone.date >= today) ?? sorted.at(-1) ?? null
}

function buildHeroLede(plan: MasterPlan, target: TargetSummary, currentPhase: MasterPlanPhase | null, totalWeeks: number, currentWeek: number): string {
  const parts = [
    `从 ${formatSlashDate(plan.start_date)} 到 ${formatSlashDate(plan.end_date)}，共 ${totalWeeks} 周。`,
    `当前处于第 ${currentWeek} 周${currentPhase ? ` · ${currentPhase.name}` : ''}，`,
  ]
  if (currentPhase?.focus) parts.push(`重点是 ${currentPhase.focus}。`)
  else parts.push('重点随训练阶段推进动态更新。')
  if (target.raceDate && target.distance) parts.push(`目标赛事：${target.distance} · ${formatSlashDate(target.raceDate)}。`)
  return parts.join('')
}

function formatDistanceBand(phase: MasterPlanPhase): string {
  return `${formatDistanceValue(phase)} km/w`
}

function formatDistanceValue(phase: MasterPlanPhase): string {
  const low = phase.weekly_distance_km_low
  const high = phase.weekly_distance_km_high
  if (low == null && high == null) return '--'
  if (low == null || high == null) return String(low ?? high ?? '--')
  return `${low}-${high}`
}

function formatKm(value: number | null): string {
  if (value == null) return '--'
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)} km`
}

function formatRange(low: number | null, high: number | null, suffix: string): string {
  if (low == null || high == null) return '--'
  const fmt = (value: number) => value.toFixed(value % 1 === 0 ? 0 : 1)
  return low === high ? fmt(low) + ' ' + suffix : fmt(low) + '-' + fmt(high) + ' ' + suffix
}

function formatPace(bar: MileageBar): string {
  if (bar.actualAvgPaceFmt) return `${bar.actualAvgPaceFmt}/km`
  if (bar.actualAvgPaceSec == null) return '--'
  const total = Math.round(bar.actualAvgPaceSec)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}/km`
}

function formatHr(bar: MileageBar): string {
  if (bar.actualAvgHr == null) return '--'
  return `${Math.round(bar.actualAvgHr)} bpm`
}

function padWeek(week: number): string {
  return String(week).padStart(2, '0')
}

function RadioCheckIcon({ color }: { color: string }) {
  return (
    <svg className="mt-1 h-4 w-4 flex-none" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.4} aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" fill={color} stroke="none" />
    </svg>
  )
}

function HistoryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 3v6h6" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M22 2 11 13" />
      <path d="m22 2-7 20-4-9-9-4 20-7Z" />
    </svg>
  )
}

function diffOpLabel(op: string): string {
  const labels: Record<string, string> = {
    add_phase: '新增阶段',
    remove_phase: '删除阶段',
    resize_phase: '调整阶段日期',
    shift_phase_boundary: '调整相邻阶段边界',
    replace_phase_focus: '调整阶段重点',
    replace_weekly_range: '调整周量区间',
    add_milestone: '新增里程碑',
    remove_milestone: '删除里程碑',
    replace_milestone_date: '调整里程碑日期',
    replace_milestone_target: '调整里程碑目标',
    reschedule_target_race: '调整目标比赛日期',
    update_target_race_time: '调整目标完赛时间',
  }
  return labels[op] ?? op
}

function defaultSelectedOpIds(diff: MasterPlanDiff | null): Set<string> {
  if (!diff) return new Set()
  const selectableOps = diff.ops.filter((op) => op.accepted !== false)
  const atomicOp = selectableOps.find((op) => isAtomicRaceOp(op.op))
  return new Set(atomicOp ? [atomicOp.id] : selectableOps.map((op) => op.id))
}

function isAtomicRaceOp(op: string): boolean {
  return op === 'reschedule_target_race' || op === 'update_target_race_time'
}

function summarizeDiffValue(op: MasterPlanDiffOp): string {
  const oldValue = compactJson(op.old_value)
  const newValue = compactJson(effectiveNewValue(op))
  return `${oldValue} -> ${newValue}`
}

function effectiveNewValue(op: MasterPlanDiffOp): Record<string, unknown> | null {
  return op.new_value && Object.keys(op.new_value).length > 0 ? op.new_value : op.spec_patch
}

function compactJson(value: Record<string, unknown> | null): string {
  if (!value || Object.keys(value).length === 0) return '无'
  return JSON.stringify(value)
}
