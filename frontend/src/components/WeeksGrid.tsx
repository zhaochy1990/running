import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getWeeks, formatWeekRange, type WeekSummary } from '../api'
import { useUser } from '../UserContextValue'
import { shanghaiToday } from '../lib/shanghai'

export default function WeeksGrid() {
  const { user } = useUser()
  const [weeks, setWeeks] = useState<WeekSummary[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    if (!user) return
    setLoading(true)
    getWeeks(user)
      .then((d) => setWeeks(d.weeks))
      .finally(() => setLoading(false))
  }, [user])

  if (loading) {
    return (
      <div className="py-10 text-center text-text-muted text-sm font-mono">加载中...</div>
    )
  }
  if (weeks.length === 0) {
    return (
      <div className="py-10 text-center text-text-muted text-sm">还没有训练周记录。</div>
    )
  }

  const today = shanghaiToday()
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {weeks.map((w) => {
        const isCurrent = w.date_from <= today && today <= w.date_to
        return (
          <button
            key={w.folder}
            onClick={() => navigate(`/week/${w.folder}`)}
            className={`text-left rounded-xl p-3.5 border transition-all ${
              isCurrent
                ? 'border-accent-green bg-gradient-to-b from-accent-green/5 to-transparent'
                : 'border-border-subtle bg-bg-card hover:border-border hover:-translate-y-px'
            }`}
          >
            <div className="flex justify-between items-baseline">
              <span className="font-mono text-[11px] font-semibold text-text-primary">
                {formatWeekRange(w.date_from, w.date_to)}
              </span>
              {w.has_feedback && (
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-accent-cyan/10 text-accent-cyan">
                  反馈
                </span>
              )}
            </div>
            <p className="text-[12px] text-text-secondary mt-2 line-clamp-2 leading-snug min-h-[2.6em]">
              {w.plan_title || '—'}
            </p>
            <div className="flex justify-between pt-2.5 mt-2.5 border-t border-border-subtle font-mono text-[11px]">
              <span className="text-text-primary">
                {w.total_km}
                <span className="text-text-muted text-[9px]"> km</span>
              </span>
              <span className="text-text-muted">{w.activity_count} 次</span>
            </div>
          </button>
        )
      })}
    </div>
  )
}
