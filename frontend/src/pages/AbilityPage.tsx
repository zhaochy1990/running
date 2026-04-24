import { useEffect, useState } from 'react'
import { useUser } from '../UserContext'
import {
  fetchAbilityCurrent, fetchAbilityHistory, fetchAbilityWeights,
  triggerAbilityBackfill,
  type AbilityCurrent, type AbilityHistoryPoint,
} from '../api'
import AbilityHero from '../components/AbilityHero'
import AbilityTriptych from '../components/AbilityTriptych'
import AbilityRadar from '../components/AbilityRadar'
import AbilityHistoryChart from '../components/AbilityHistoryChart'
import Vo2maxPanel from '../components/Vo2maxPanel'

export default function AbilityPage() {
  const { user } = useUser()
  const [current, setCurrent] = useState<AbilityCurrent | null>(null)
  const [history, setHistory] = useState<AbilityHistoryPoint[]>([])
  const [weights, setWeights] = useState<Record<string, number> | null>(null)
  const [days, setDays] = useState(90)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [backfilling, setBackfilling] = useState(false)

  useEffect(() => {
    if (!user) return
    setLoading(true)
    setError(null)
    Promise.all([
      fetchAbilityCurrent(user),
      fetchAbilityHistory(user, days),
      fetchAbilityWeights(user).catch(() => null),
    ])
      .then(async ([cur, hist, w]) => {
        setCurrent(cur)
        setWeights(w?.l4_weights ?? null)
        // Auto-trigger 180d backfill if the history table is empty (first visit).
        if (hist.length === 0) {
          setBackfilling(true)
          try {
            await triggerAbilityBackfill(user, 180)
            const refreshed = await fetchAbilityHistory(user, days)
            setHistory(refreshed)
          } catch {
            setHistory([])
          } finally {
            setBackfilling(false)
          }
        } else {
          setHistory(hist)
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [user, days])

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
          <p className="text-xs font-mono text-text-muted text-center max-w-md">
            成绩预测实时计算中，通常需要 10-15 秒…
            <br />
            <span className="text-[10px] text-text-muted/70">性能优化待后续修复</span>
          </p>
        </div>
      ) : error ? (
        <div className="bg-accent-red/10 border border-accent-red/30 rounded-xl p-6 text-center">
          <p className="text-sm font-mono text-accent-red">加载失败: {error}</p>
        </div>
      ) : current ? (
        <div className="animate-fade-in">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-text-primary tracking-tight">成绩预测</h1>
              <p className="text-xs text-text-muted mt-1">
                Performance Prediction · 4-layer custom score
                <span className="ml-2 font-mono text-[10px]">
                  [{current.source === 'snapshot' ? '快照' : '实时计算'}]
                </span>
              </p>
            </div>
          </div>

          <AbilityHero estimates={current.marathon_estimates} date={current.date} />

          <AbilityTriptych estimates={current.marathon_estimates} />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <AbilityRadar current={current} weights={weights} />
            <Vo2maxPanel vo2max={current.l3_dimensions.vo2max} />
          </div>

          <div className="mb-6">
            {backfilling ? (
              <div className="bg-bg-card border border-border-subtle rounded-2xl p-8 text-center animate-fade-in">
                <div className="w-5 h-5 mx-auto mb-3 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
                <p className="text-xs font-mono text-text-muted">
                  首次访问 — 正在回填 180 天成绩历史…
                </p>
              </div>
            ) : (
              <AbilityHistoryChart history={history} days={days} onDaysChange={setDays} />
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
