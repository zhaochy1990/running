import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  getTrainingPlan,
  getCurrentMasterPlan,
  type TrainingPlan,
  type MasterPlan,
  type MasterPlanPhase,
} from '../api'
import { shanghaiToday } from '../lib/shanghai'
import { useUser } from '../UserContextValue'
import TrainingPlanSetup from './TrainingPlanSetup'
import ViewHead from '../components/ViewHead'
import WeeksGrid from '../components/WeeksGrid'

type PlanTab = 'overview' | 'weeks'

// Phase color band keyed by phase_type (base / build / peak / taper / race /
// recovery). Falls back to a name-keyword heuristic, then neutral.
const PHASE_TYPE_COLORS: Record<string, string> = {
  base: '#00e676',
  build: '#00e5ff',
  peak: '#ffab00',
  taper: '#b388ff',
  race: '#ff1744',
  recovery: '#8888a0',
}

function phaseColor(phase: MasterPlanPhase, index: number): string {
  if (phase.phase_type && PHASE_TYPE_COLORS[phase.phase_type]) return PHASE_TYPE_COLORS[phase.phase_type]
  const name = phase.name
  if (name.includes('基础') || name.includes('Base')) return PHASE_TYPE_COLORS.base
  if (name.includes('专项') || name.includes('Build')) return PHASE_TYPE_COLORS.build
  if (name.includes('马拉松') || name.includes('Peak')) return PHASE_TYPE_COLORS.peak
  if (name.includes('减量') || name.includes('Taper')) return PHASE_TYPE_COLORS.taper
  if (name.includes('比赛') || name.includes('Race') || name.includes('恢复')) return PHASE_TYPE_COLORS.race
  const fallback = ['#00e676', '#00e5ff', '#ffab00', '#b388ff', '#ff1744']
  return fallback[index % fallback.length]
}

function shortPhaseName(phase: MasterPlanPhase, index: number): string {
  const n = phase.name
  if (n.includes('基础') || n.includes('Base')) return 'P1 基础'
  if (n.includes('专项') || n.includes('Build')) return 'P2 专项'
  if (n.includes('马拉松') || n.includes('Peak')) return 'P3 峰值'
  if (n.includes('减量') || n.includes('Taper')) return 'P4 减量'
  if (n.includes('比赛') || n.includes('Race')) return '比赛'
  if (n.includes('恢复') || n.includes('Recovery')) return '恢复'
  return `P${index + 1}`
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

type PageState = 'loading' | 'setup' | 'plan'

export default function TrainingPlanPage() {
  const { user } = useUser()
  const navigate = useNavigate()
  const [masterPlan, setMasterPlan] = useState<MasterPlan | null>(null)
  const [fallbackPlan, setFallbackPlan] = useState<TrainingPlan | null>(null)
  const [pageState, setPageState] = useState<PageState>('loading')
  const [planTab, setPlanTab] = useState<PlanTab>('overview')
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(null)
  const requestKey = user || ''
  const [loadedKey, setLoadedKey] = useState('')

  const loadPlan = useCallback(() => {
    if (!user) return
    let cancelled = false
    setLoadedKey('')

    // The master plan is the source of truth for whether the user has a
    // season plan. 404 → null → setup flow. The legacy markdown plan is loaded
    // alongside as a supporting tab / fallback overview.
    Promise.all([
      getCurrentMasterPlan().catch(() => null),
      getTrainingPlan(user).catch(() => null),
    ]).then(([master, fallback]) => {
      if (cancelled) return
      setMasterPlan(master)
      setFallbackPlan(fallback)
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
    loadPlan()
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

  // Plan view — prefer the structured master plan; fall back to markdown.
  if (masterPlan) {
    return (
      <SeasonOverview
        plan={masterPlan}
        tab={planTab}
        onTab={setPlanTab}
        selectedPhaseId={selectedPhaseId}
        onSelectPhase={setSelectedPhaseId}
        onAdjust={() => navigate('/plan/adjust')}
      />
    )
  }

  // Legacy markdown-only fallback (no structured master plan yet).
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

// ─── Season overview (screen 3) ─────────────────────────────────────────────

function SeasonOverview({
  plan,
  tab,
  onTab,
  selectedPhaseId,
  onSelectPhase,
  onAdjust,
}: {
  plan: MasterPlan
  tab: PlanTab
  onTab: (tab: PlanTab) => void
  selectedPhaseId: string | null
  onSelectPhase: (id: string) => void
  onAdjust: () => void
}) {
  const phases = plan.phases
  const currentPhaseId = plan.current_phase_id
  // Default the selected phase to the current phase (or the first).
  const activePhaseId = selectedPhaseId
    ?? currentPhaseId
    ?? (phases[0]?.id ?? null)
  const activePhase = phases.find((p) => p.id === activePhaseId) ?? phases[0] ?? null
  const activeIndex = activePhase ? phases.findIndex((p) => p.id === activePhase.id) : -1

  const totalStart = phases.length > 0 ? parseDateOnly(phases[0].start_date)?.getTime() ?? 0 : 0
  const totalEnd = phases.length > 0 ? parseDateOnly(phases[phases.length - 1].end_date)?.getTime() ?? 0 : 0
  const totalSpan = totalEnd - totalStart || 1

  const totalWeeks = plan.total_weeks ?? phases.reduce((sum, p) => sum + weeksBetween(p.start_date, p.end_date), 0)
  const today = shanghaiToday()
  const generatedAt = plan.updated_at?.slice(0, 10) || plan.created_at?.slice(0, 10) || today

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:px-8 sm:py-8 animate-fade-in">
      <div className="flex items-start justify-between gap-4 mb-6">
        <ViewHead
          eyebrow={`${totalWeeks || '--'} 周训练计划 · 赛季总纲`}
          title="从基础到比赛 · 训练总览"
          lede={`由 STRIDE 生成 · ${generatedAt}`}
        />
        <button
          type="button"
          onClick={onAdjust}
          className="shrink-0 inline-flex items-center gap-2 rounded-lg bg-accent-green/90 px-4 py-2 text-xs font-semibold text-bg-base hover:bg-accent-green transition-colors cursor-pointer"
        >
          <RefreshIcon />
          调整 / 重新生成计划
        </button>
      </div>

      <div className="inline-flex gap-0.5 p-0.5 bg-bg-elevated rounded-lg mb-5">
        <button
          type="button"
          onClick={() => onTab('overview')}
          className={`px-3.5 py-1.5 text-[12px] font-medium rounded-md transition-colors ${
            tab === 'overview'
              ? 'bg-bg-card text-text-primary font-semibold shadow-sm'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          赛季总览
        </button>
        <button
          type="button"
          onClick={() => onTab('weeks')}
          className={`px-3.5 py-1.5 text-[12px] font-medium rounded-md transition-colors ${
            tab === 'weeks'
              ? 'bg-bg-card text-text-primary font-semibold shadow-sm'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          训练周列表
        </button>
      </div>

      {tab === 'weeks' ? (
        <WeeksGrid />
      ) : (
        <div className="space-y-6">
          {/* Phase timeline band */}
          {phases.length > 0 && (
            <div className="bg-bg-card border border-border-subtle rounded-2xl p-4 sm:p-6">
              <h3 className="text-sm font-semibold text-text-secondary mb-4 tracking-wide">训练周期</h3>
              <div className="flex rounded-lg overflow-hidden h-14">
                {phases.map((phase, i) => {
                  const start = parseDateOnly(phase.start_date)?.getTime() ?? 0
                  const end = parseDateOnly(phase.end_date)?.getTime() ?? 0
                  const width = ((end - start) / totalSpan) * 100
                  const isActive = phase.id === activePhase?.id
                  const isCurrent = phase.id === currentPhaseId
                  const color = phaseColor(phase, i)
                  return (
                    <button
                      key={phase.id}
                      type="button"
                      onClick={() => onSelectPhase(phase.id)}
                      className={`relative flex items-center justify-center transition-all ${isActive ? 'z-10' : 'opacity-60 hover:opacity-90'}`}
                      style={{
                        width: `${Math.max(width, 4)}%`,
                        backgroundColor: color + (isActive ? '30' : '18'),
                        borderRight: i < phases.length - 1 ? '1px solid var(--color-bg-card)' : 'none',
                        boxShadow: isActive ? `inset 0 0 0 2px ${color}` : undefined,
                      }}
                      title={`${phase.name}: ${formatShort(phase.start_date)} — ${formatShort(phase.end_date)}${isCurrent ? ' · 当前' : ''}`}
                    >
                      <span className="text-sm font-mono font-semibold truncate px-2" style={{ color }}>
                        {shortPhaseName(phase, i)}
                      </span>
                    </button>
                  )
                })}
              </div>
              <div className="flex mt-2">
                {phases.map((phase) => {
                  const start = parseDateOnly(phase.start_date)?.getTime() ?? 0
                  const end = parseDateOnly(phase.end_date)?.getTime() ?? 0
                  const width = ((end - start) / totalSpan) * 100
                  return (
                    <div key={phase.id} className="text-center" style={{ width: `${Math.max(width, 4)}%` }}>
                      <span className="text-xs font-mono text-text-muted">{formatShort(phase.start_date)}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Phase selector pills */}
          {phases.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {phases.map((phase, i) => {
                const isActive = phase.id === activePhase?.id
                const isCompleted = phase.is_completed === true
                const color = phaseColor(phase, i)
                const weeks = weeksBetween(phase.start_date, phase.end_date)
                return (
                  <button
                    key={phase.id}
                    type="button"
                    onClick={() => onSelectPhase(phase.id)}
                    className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                      isCompleted ? 'opacity-55' : ''
                    } ${
                      isActive
                        ? 'border-transparent text-text-primary font-semibold'
                        : 'border-border-subtle bg-bg-card text-text-secondary hover:text-text-primary'
                    }`}
                    style={isActive ? { backgroundColor: color + '20' } : undefined}
                    title={isCompleted ? '已完成阶段' : undefined}
                  >
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                    {shortPhaseName(phase, i)} · {isCompleted ? `${weeks} 周 ✓` : `${weeks} 周`}
                  </button>
                )
              })}
            </div>
          )}

          {/* Selected phase detail with editorial fields */}
          {activePhase && (
            <PhaseDetail phase={activePhase} index={activeIndex < 0 ? 0 : activeIndex} />
          )}
        </div>
      )}
    </div>
  )
}

function PhaseDetail({ phase, index }: { phase: MasterPlanPhase; index: number }) {
  const color = phaseColor(phase, index)
  const triggers = phase.monitoring_triggers ?? []
  const band = useMemo(() => {
    const low = phase.weekly_distance_km_low
    const high = phase.weekly_distance_km_high
    if (low == null && high == null) return '周量 —'
    return `${low ?? '--'}-${high ?? '--'} km/w`
  }, [phase.weekly_distance_km_low, phase.weekly_distance_km_high])
  const weeks = weeksBetween(phase.start_date, phase.end_date)

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      {/* Left editorial column */}
      <article className="bg-bg-card border border-border-subtle rounded-2xl p-5 sm:p-6 space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
            <span className="text-xs font-mono text-text-muted uppercase tracking-wider">
              {formatShort(phase.start_date)} — {formatShort(phase.end_date)} · {weeks} 周 · {band}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-text-primary">{phase.name}</h3>
            {phase.is_completed && (
              <span className="inline-flex items-center rounded-full bg-bg-elevated border border-border-subtle px-2 py-0.5 text-[10px] font-mono text-text-muted uppercase tracking-wider">
                已完成
              </span>
            )}
          </div>
          {phase.focus && <p className="text-sm text-text-secondary mt-1.5 leading-relaxed">{phase.focus}</p>}
        </div>

        {phase.rhythm && (
          <EditorialBlock num="01" title="阶段节奏" body={phase.rhythm} />
        )}
        {phase.key_workouts && (
          <EditorialBlock num="02" title="关键课型" body={phase.key_workouts} />
        )}
        {triggers.length > 0 && (
          <div>
            <h4 className="text-xs font-mono font-bold text-text-primary uppercase tracking-wider mb-3 flex items-center gap-2">
              <span className="w-6 h-6 flex items-center justify-center bg-text-primary text-bg-base text-[10px] rounded">03</span>
              监控触发
            </h4>
            <ul className="space-y-2 pl-8 border-l-2 border-border-subtle">
              {triggers.map((t, i) => (
                <li key={i} className="text-sm text-text-secondary leading-relaxed">{t}</li>
              ))}
            </ul>
          </div>
        )}

        {phase.coach_note && (
          <blockquote
            className="text-sm italic text-text-secondary border-l-4 pl-5 py-3 rounded-r-lg leading-relaxed"
            style={{ borderColor: color, backgroundColor: color + '0d' }}
          >
            {phase.coach_note}
            <footer className="text-xs font-mono text-text-muted mt-3 not-italic">— Coach STRIDE Intelligence</footer>
          </blockquote>
        )}
      </article>

      {/* Right side cards */}
      <aside className="space-y-4">
        <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 space-y-3">
          <h5 className="text-xs font-mono text-text-muted uppercase tracking-wider">关键课型</h5>
          {phase.key_session_types.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {phase.key_session_types.map((s, i) => (
                <span key={i} className="inline-flex items-center rounded-md bg-bg-base border border-border-subtle px-2 py-1 text-xs text-text-secondary">
                  {s}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-text-muted">暂无关键课型</p>
          )}
        </div>

        <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 space-y-3">
          <h5 className="text-xs font-mono text-text-muted uppercase tracking-wider">周里程区间</h5>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold text-text-primary tabular-nums">{band}</span>
          </div>
          <p className="text-xs text-text-muted">{weeks} 周 · {formatShort(phase.start_date)} — {formatShort(phase.end_date)}</p>
        </div>
      </aside>
    </div>
  )
}

function EditorialBlock({ num, title, body }: { num: string; title: string; body: string }) {
  return (
    <div>
      <h4 className="text-xs font-mono font-bold text-text-primary uppercase tracking-wider mb-3 flex items-center gap-2">
        <span className="w-6 h-6 flex items-center justify-center bg-text-primary text-bg-base text-[10px] rounded">{num}</span>
        {title}
      </h4>
      <p className="text-sm text-text-secondary leading-relaxed pl-8 border-l-2 border-border-subtle">{body}</p>
    </div>
  )
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M21 12a9 9 0 11-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}
