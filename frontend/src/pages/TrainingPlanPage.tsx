import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getTrainingPlan, getMyProfile, type TrainingPlan } from '../api'
import { useUser } from '../UserContextValue'
import TrainingPlanSetup from './TrainingPlanSetup'
import ViewHead from '../components/ViewHead'
import WeeksGrid from '../components/WeeksGrid'

type PlanTab = 'overview' | 'weeks'

const PHASE_COLORS: Record<string, string> = {
  '赛后恢复': '#8888a0',
  '第0周': '#64dd17',
  'Phase 1：基础期': '#00e676',
  'Phase 2：专项期': '#00e5ff',
  'Phase 3：马拉松期': '#ffab00',
  'Phase 4：减量期': '#b388ff',
  '比赛窗口': '#ff1744',
}

function phaseColor(name: string): string {
  return PHASE_COLORS[name] || '#8888a0'
}

function shortName(name: string): string {
  if (name.includes('Phase 1')) return 'P1 基础'
  if (name.includes('Phase 2')) return 'P2 专项'
  if (name.includes('Phase 3')) return 'P3 马拉松'
  if (name.includes('Phase 4')) return 'P4 减量'
  if (name === '比赛窗口') return '比赛'
  if (name === '第0周') return 'W0'
  return name
}

function formatShort(dateStr: string): string {
  const parts = dateStr.split('-')
  return `${parseInt(parts[1])}/${parseInt(parts[2])}`
}

type PageState = 'loading' | 'setup' | 'plan'

export default function TrainingPlanPage() {
  const { user } = useUser()
  const [plan, setPlan] = useState<TrainingPlan | null>(null)
  const [pageState, setPageState] = useState<PageState>('loading')
  const [planTab, setPlanTab] = useState<PlanTab>('overview')
  const requestKey = user || ''
  const [loadedKey, setLoadedKey] = useState('')

  const loadPlan = useCallback(() => {
    if (!user) return
    let cancelled = false
    setLoadedKey('')

    // Load plan + profile in parallel to decide what to show
    Promise.all([
      getTrainingPlan(user).catch(() => null),
      getMyProfile().catch(() => null),
    ]).then(([planData, profile]) => {
      if (cancelled) return
      setPlan(planData)

      // If there's plan content, show it directly
      if (planData?.content) {
        setPageState('plan')
      } else {
        // No plan — check if race goals are set
        const p = profile?.profile
        const hasRaceGoal = p && p.target_race && p.target_distance && p.target_race_date && p.target_time
        if (hasRaceGoal) {
          // Race goals set but no plan content yet — show plan page
          // (plan may be generating or not yet created)
          setPageState('plan')
        } else {
          // No race goals — show setup flow
          setPageState('setup')
        }
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
          eyebrow="训练计划 · 起步"
          title="设置你的比赛目标"
          lede="设置目标赛事并同步历史数据，AI 教练会基于你的能力生成 23 周训练计划"
        />
        <TrainingPlanSetup
          onComplete={() => {
            // Reload plan data after sync completes
            setPageState('loading')
            loadPlan()
          }}
        />
      </div>
    )
  }

  // Plan view
  if (!plan?.content) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6 sm:px-8 sm:py-8 animate-fade-in">
        <ViewHead
          eyebrow="训练计划"
          title="训练计划生成中"
          lede="历史数据已同步完成，训练计划正在后台生成"
        />
        <div className="text-text-muted text-center py-20">
          <p>历史数据已同步完成，训练计划正在生成中</p>
          <p className="text-xs mt-2">请稍后刷新页面查看</p>
        </div>
      </div>
    )
  }

  // Calculate timeline proportions
  const phases = plan.phases
  const totalStart = phases.length > 0 ? new Date(phases[0].start).getTime() : 0
  const totalEnd = phases.length > 0 ? new Date(phases[phases.length - 1].end).getTime() : 0
  const totalSpan = totalEnd - totalStart || 1

  const planLede = plan.current_phase
    ? `当前阶段 · ${plan.current_phase}`
    : 'AI 教练基于你的能力生成的 23 周训练总纲'

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:px-8 sm:py-8 animate-fade-in">
      <ViewHead
        eyebrow="23 周训练计划 · 西安马拉松"
        title="从基础到比赛 · 训练总览"
        lede={planLede}
      />

      <div className="inline-flex gap-0.5 p-0.5 bg-bg-elevated rounded-lg mb-5">
        <button
          type="button"
          onClick={() => setPlanTab('overview')}
          className={`px-3.5 py-1.5 text-[12px] font-medium rounded-md transition-colors ${
            planTab === 'overview'
              ? 'bg-bg-card text-text-primary font-semibold shadow-sm'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          总览 · plan.md
        </button>
        <button
          type="button"
          onClick={() => setPlanTab('weeks')}
          className={`px-3.5 py-1.5 text-[12px] font-medium rounded-md transition-colors inline-flex items-center gap-1.5 ${
            planTab === 'weeks'
              ? 'bg-bg-card text-text-primary font-semibold shadow-sm'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          训练周列表
        </button>
      </div>

      {planTab === 'overview' ? (
        <div>
          {plan.current_phase && (
            <div className="flex items-center gap-2 mb-6">
              <span className="text-sm text-text-muted">当前阶段</span>
              <span
                className="text-sm font-semibold px-3 py-1 rounded-lg"
                style={{
                  color: phaseColor(plan.current_phase),
                  backgroundColor: phaseColor(plan.current_phase) + '15',
                }}
              >
                {plan.current_phase}
              </span>
            </div>
          )}

      {/* Phase Timeline */}
      {phases.length > 0 && (
        <div className="bg-bg-card border border-border-subtle rounded-2xl p-4 sm:p-6 mb-6">
          <h3 className="text-sm font-semibold text-text-secondary mb-4 tracking-wide">训练周期</h3>

          {/* Timeline bar */}
          <div className="relative">
            <div className="flex rounded-lg overflow-hidden h-14">
              {phases.map((phase, i) => {
                const start = new Date(phase.start).getTime()
                const end = new Date(phase.end).getTime()
                const width = ((end - start) / totalSpan) * 100
                const isCurrent = phase.name === plan.current_phase
                const color = phaseColor(phase.name)

                return (
                  <div
                    key={i}
                    className={`relative flex items-center justify-center transition-all ${
                      isCurrent ? 'z-10' : 'opacity-60 hover:opacity-90'
                    }`}
                    style={{
                      width: `${Math.max(width, 3)}%`,
                      backgroundColor: color + (isCurrent ? '30' : '18'),
                      borderRight: i < phases.length - 1 ? '1px solid var(--color-bg-card)' : 'none',
                      boxShadow: isCurrent ? `inset 0 0 0 2px ${color}` : undefined,
                    }}
                    title={`${phase.name}: ${formatShort(phase.start)} — ${formatShort(phase.end)}`}
                  >
                    <span
                      className="text-sm font-mono font-semibold truncate px-2"
                      style={{ color }}
                    >
                      {shortName(phase.name)}
                    </span>
                  </div>
                )
              })}
            </div>

            {/* Date labels */}
            <div className="flex mt-2">
              {phases.map((phase, i) => {
                const start = new Date(phase.start).getTime()
                const end = new Date(phase.end).getTime()
                const width = ((end - start) / totalSpan) * 100
                return (
                  <div key={i} className="text-center" style={{ width: `${Math.max(width, 3)}%` }}>
                    <span className="text-xs font-mono text-text-muted">
                      {formatShort(phase.start)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Today marker description */}
          {plan.current_phase && (
            <div className="flex items-center gap-2 mt-4 pt-3 border-t border-border-subtle">
              <div
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ backgroundColor: phaseColor(plan.current_phase) }}
              />
              <span className="text-xs text-text-muted">
                今天 — {plan.current_phase}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Full plan markdown */}
      <div className="bg-bg-card border border-border-subtle rounded-2xl p-4 sm:p-6">
        <div className="prose max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan.content}</ReactMarkdown>
        </div>
      </div>
        </div>
      ) : (
        <WeeksGrid />
      )}
    </div>
  )
}
