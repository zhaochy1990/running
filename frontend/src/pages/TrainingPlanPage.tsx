import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  getCurrentMasterPlan,
  getMyProfile,
  getTrainingGoal,
  getTrainingPlan,
  type CompletedPhaseSummary,
  type MasterPlan,
  type MasterPlanMilestone,
  type MasterPlanPhase,
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
  km: number | null
  heightPct: number
  phase: MasterPlanPhase
  phaseIndex: number
  isCurrent: boolean
  title: string
}

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

function targetFrom(goal: TrainingGoal | null, profile: MyProfile | null): TargetSummary {
  const rawProfile = profile?.profile ?? null
  const raceName = goal?.race_name?.trim() || stringField(rawProfile, 'target_race')
  const distance = goal?.race_distance || stringField(rawProfile, 'target_distance')
  const raceDate = goal?.race_date || stringField(rawProfile, 'target_race_date')
  const targetTime = goal?.target_finish_time || stringField(rawProfile, 'target_time')
  return {
    raceName,
    distance: distanceLabel(distance),
    raceDate,
    targetTime,
  }
}

type PageState = 'loading' | 'setup' | 'plan'

export default function TrainingPlanPage() {
  const { user } = useUser()
  const navigate = useNavigate()
  const [masterPlan, setMasterPlan] = useState<MasterPlan | null>(null)
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
      getTrainingPlan(user).catch(() => null),
      getTrainingGoal().catch(() => null),
      getMyProfile().catch(() => null),
    ]).then(([master, fallback, goal, profile]) => {
      if (cancelled) return
      setMasterPlan(master)
      setFallbackPlan(fallback)
      setTarget(targetFrom(goal, profile))
      if (master || fallback?.content) {
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
          onComplete={() => {
            setPageState('loading')
            loadPlan()
          }}
        />
      </div>
    )
  }

  if (masterPlan) {
    return (
      <SeasonOverview
        plan={masterPlan}
        target={target}
        tab={planTab}
        onTab={setPlanTab}
        selectedPhaseId={selectedPhaseId}
        onSelectPhase={setSelectedPhaseId}
        onAdjust={() => navigate('/plan/adjust')}
      />
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
        <div className="space-y-6">
          {spans.length > 0 && (
            <MileageCycleCard
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
  spans,
  totalWeeks,
  currentWeek,
  onSelectPhase,
}: {
  spans: PhaseSpan[]
  totalWeeks: number
  currentWeek: number
  onSelectPhase: (id: string) => void
}) {
  const bars = useMemo(() => buildMileageBars(spans, totalWeeks, currentWeek), [spans, totalWeeks, currentWeek])
  const columns = Math.max(bars.length, 1)

  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-bg-card">
      <div className="border-b border-border-subtle px-5 py-4">
        <h2 className="text-lg font-semibold text-text-primary">训练周期</h2>
      </div>
      <div className="px-5 py-5 sm:px-6">
        <p className="mb-4 font-mono text-[10px] font-semibold tracking-[0.14em] text-text-muted uppercase">
          预计周跑量（KM/周）
        </p>
        <div
          className="grid h-40 items-end gap-1.5"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {bars.map((bar) => {
            const visual = phaseVisual(bar.phase, bar.phaseIndex)
            return (
              <button
                key={bar.week}
                type="button"
                title={bar.title}
                aria-label={bar.title}
                onClick={() => onSelectPhase(bar.phase.id)}
                className={`relative min-h-[10px] rounded-t transition-all hover:opacity-90 ${bar.isCurrent ? 'ring-2 ring-accent-green ring-offset-2 ring-offset-bg-primary' : ''}`}
                style={{
                  height: `${bar.heightPct}%`,
                  backgroundColor: bar.isCurrent ? visual.color : `color-mix(in oklab, ${visual.color} 42%, var(--surface))`,
                }}
              >
                {bar.isCurrent && (
                  <span className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] font-semibold text-accent-green">
                    W{padWeek(bar.week)} 当前
                  </span>
                )}
              </button>
            )
          })}
        </div>
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

function buildMileageBars(spans: PhaseSpan[], totalWeeks: number, currentWeek: number): MileageBar[] {
  const raw = spans.flatMap((span) => Array.from({ length: span.weekCount }, (_, localIndex) => {
    const week = span.weekStart + localIndex
    const km = interpolateWeeklyKm(span.phase, localIndex, span.weekCount)
    return { week, km, phase: span.phase, phaseIndex: span.index }
  })).filter((bar) => !totalWeeks || bar.week <= totalWeeks)
  const maxKm = Math.max(...raw.map((bar) => bar.km ?? 0), 1)
  return raw.map((bar) => ({
    ...bar,
    heightPct: bar.km == null ? 42 : Math.max(8, Math.round((bar.km / maxKm) * 100)),
    isCurrent: bar.week === currentWeek,
    title: bar.km == null ? `W${padWeek(bar.week)} 暂无周量数据` : `W${padWeek(bar.week)} ${bar.km}km · ${bar.phase.name}`,
  }))
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
