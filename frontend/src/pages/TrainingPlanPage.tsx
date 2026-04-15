import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getTrainingPlan, type TrainingPlan } from '../api'
import { useUser } from '../UserContext'

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

export default function TrainingPlanPage() {
  const navigate = useNavigate()
  const { user } = useUser()
  const [plan, setPlan] = useState<TrainingPlan | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    setLoading(true)
    getTrainingPlan(user)
      .then(setPlan)
      .finally(() => setLoading(false))
  }, [user])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }

  if (!plan?.content) {
    return <div className="text-text-muted text-center py-20">暂无训练计划</div>
  }

  // Calculate timeline proportions
  const phases = plan.phases
  const totalStart = phases.length > 0 ? new Date(phases[0].start).getTime() : 0
  const totalEnd = phases.length > 0 ? new Date(phases[phases.length - 1].end).getTime() : 0
  const totalSpan = totalEnd - totalStart || 1

  return (
    <div className="max-w-5xl mx-auto px-8 py-8 animate-fade-in">
      {/* Back link */}
      <button
        onClick={() => navigate('/')}
        className="inline-flex items-center gap-2 text-sm text-text-muted hover:text-accent-green transition-colors mb-6 cursor-pointer"
      >
        <span>&lsaquo;</span> 返回
      </button>

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-primary tracking-tight">训练总计划</h1>
        {plan.current_phase && (
          <div className="flex items-center gap-2 mt-2">
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
      </div>

      {/* Phase Timeline */}
      {phases.length > 0 && (
        <div className="bg-bg-card border border-border-subtle rounded-2xl p-6 mb-6">
          <h3 className="text-sm font-semibold text-text-secondary mb-4 tracking-wide">训练周期</h3>

          {/* Timeline bar */}
          <div className="relative">
            <div className="flex rounded-lg overflow-hidden h-10">
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
                      className="text-[10px] font-mono font-semibold truncate px-1"
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
                    <span className="text-[9px] font-mono text-text-muted">
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
      <div className="bg-bg-card border border-border-subtle rounded-2xl p-6">
        <div className="prose max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan.content}</ReactMarkdown>
        </div>
      </div>
    </div>
  )
}
