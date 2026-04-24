import { useEffect, useState } from 'react'
import { fetchActivityAbility, type Activity, type ActivityAbility } from '../api'

const SUB_SCORES: Array<{ key: string; label: string; weight: number }> = [
  { key: 'pace_adherence', label: '配速贴合度', weight: 30 },
  { key: 'hr_zone_adherence', label: '心率区间', weight: 25 },
  { key: 'pace_stability', label: '配速稳定性', weight: 20 },
  { key: 'hr_decoupling', label: '心率漂移控制', weight: 15 },
  { key: 'cadence_stability', label: '步频稳定性', weight: 10 },
]

const L3_LABELS: Record<string, string> = {
  aerobic: '有氧能力',
  lt: '乳酸阈',
  vo2max: '最大摄氧',
  endurance: '耐力储备',
  economy: '跑步经济性',
  recovery: '恢复能力',
}

function subScoreColor(score: number | undefined): string {
  if (score == null) return '#8888a0'
  if (score >= 85) return '#00a85a'
  if (score >= 70) return '#64dd17'
  if (score >= 55) return '#e68a00'
  if (score >= 40) return '#ff6d00'
  return '#d32f2f'
}

function qualityColor(score: number | null): string {
  if (score == null) return '#8888a0'
  if (score >= 85) return '#00a85a'
  if (score >= 70) return '#64dd17'
  if (score >= 55) return '#e68a00'
  return '#d32f2f'
}

function isEvidenceRun(activity: Activity): boolean {
  const evidenceTypes = new Set(['Interval', 'VO2 Max', 'Threshold'])
  if (activity.train_type && evidenceTypes.has(activity.train_type)) return true
  if (activity.distance_km >= 25) return true
  return false
}

export default function ActivityContributionCard({
  user,
  activity,
}: {
  user: string
  activity: Activity
}) {
  const [data, setData] = useState<ActivityAbility | null>(null)
  const [loading, setLoading] = useState(true)
  const [notComputed, setNotComputed] = useState(false)

  useEffect(() => {
    if (!user || !activity?.label_id) return
    let cancelled = false
    setLoading(true)
    setNotComputed(false)
    fetchActivityAbility(user, activity.label_id)
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch(() => {
        if (!cancelled) setNotComputed(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user, activity?.label_id])

  if (loading) {
    return (
      <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 mb-6">
        <div className="flex items-center gap-3 text-xs font-mono text-text-muted">
          <div className="w-3.5 h-3.5 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
          加载训练质量…
        </div>
      </div>
    )
  }

  if (notComputed || !data) {
    return (
      <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 mb-6">
        <h3 className="text-sm font-semibold text-text-secondary mb-2 tracking-wide">本次训练质量</h3>
        <p className="text-xs font-mono text-text-muted leading-relaxed">
          实力贡献数据待算（运行 <code className="px-1.5 py-0.5 rounded bg-bg-secondary text-text-secondary">coros-sync ability for {activity.label_id}</code> 重新同步）
        </p>
      </div>
    )
  }

  const breakdown = data.l1_breakdown || {}
  const quality = data.l1_quality
  const contribution = data.contribution || {}
  const contributionEntries = Object.entries(contribution)
    .filter(([, v]) => typeof v === 'number' && Math.abs(v) >= 0.05)
    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
  const evidenceRun = isEvidenceRun(activity)

  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 mb-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-baseline justify-between mb-5">
        <div className="flex items-baseline gap-3">
          <h3 className="text-sm font-semibold text-text-secondary tracking-wide">本次训练质量</h3>
          {evidenceRun && (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-md"
              style={{ color: '#00a85a', backgroundColor: '#00a85a15' }}
              title={
                activity.train_type && ['Interval', 'VO2 Max', 'Threshold'].includes(activity.train_type)
                  ? `${activity.train_type} 训练为实力提供新证据`
                  : `≥25km 长距离为耐力提供新证据`
              }
            >
              <span>★</span>
              <span>本次提供了新证据</span>
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-bold font-mono" style={{ color: qualityColor(quality) }}>
            {quality != null ? quality.toFixed(0) : '—'}
          </span>
          <span className="text-xs font-mono text-text-muted">/100</span>
        </div>
      </div>

      {/* 5 Sub-score breakdown */}
      <div className="space-y-2.5">
        {SUB_SCORES.map(({ key, label, weight }) => {
          const raw = breakdown[key]
          const score = typeof raw === 'number' ? raw : undefined
          const pct = score != null ? Math.max(0, Math.min(100, score)) : 0
          const color = subScoreColor(score)
          return (
            <div key={key as string} className="group">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-mono text-text-muted">
                  {label}
                  <span className="text-text-muted/70 ml-1.5">({weight}%)</span>
                </span>
                <span
                  className="text-xs font-mono font-medium min-w-[40px] text-right"
                  style={{ color }}
                >
                  {score != null ? score.toFixed(0) : '—'}
                </span>
              </div>
              <div className="h-2.5 bg-bg-secondary rounded-md overflow-hidden">
                <div
                  className="h-full rounded-md transition-all duration-500 ease-out group-hover:brightness-125"
                  style={{
                    width: `${pct}%`,
                    backgroundColor: color,
                    opacity: 0.8,
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>

      {/* L3 contribution deltas */}
      <div className="mt-5 pt-4 border-t border-border-subtle">
        <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">
          对 L3 实力的贡献
        </h4>
        {contributionEntries.length === 0 ? (
          <p className="text-xs font-mono text-text-muted">
            {evidenceRun
              ? '本次变动较小，但已被记入实力证据池。'
              : '本次训练未对 L3 实力产生明显影响（|Δ| < 0.05）。'}
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2">
            {contributionEntries.map(([dim, delta]) => {
              const sign = delta > 0 ? '+' : ''
              const color = delta > 0 ? '#00a85a' : '#d32f2f'
              return (
                <div key={dim} className="flex items-center justify-between">
                  <span className="text-xs font-mono text-text-muted">
                    {L3_LABELS[dim] || dim}
                  </span>
                  <span className="text-xs font-mono font-medium" style={{ color }}>
                    {sign}
                    {delta.toFixed(2)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
