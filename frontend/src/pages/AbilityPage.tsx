import { useEffect, useState } from 'react'
import { useUser } from '../UserContextValue'
import {
  fetchAbilityCurrent, fetchAbilityHistory, fetchAbilityWeights, fetchPbs,
  triggerAbilityBackfill,
  type AbilityCurrent, type AbilityHistoryPoint, type PBEntry, type RaceEstimates,
} from '../api'
import AbilityHero from '../components/AbilityHero'
import AbilityTriptych from '../components/AbilityTriptych'
import AbilityRadar from '../components/AbilityRadar'
import AbilityHistoryChart from '../components/AbilityHistoryChart'
import AbilityPBTable from '../components/AbilityPBTable'
import Vo2maxPanel from '../components/Vo2maxPanel'
import ViewHead from '../components/ViewHead'

const EMPTY_ESTIMATES: RaceEstimates = { training_s: null, race_s: null, best_case_s: null }

export default function AbilityPage() {
  const { user } = useUser()
  const [current, setCurrent] = useState<AbilityCurrent | null>(null)
  const [history, setHistory] = useState<AbilityHistoryPoint[]>([])
  const [pbs, setPbs] = useState<PBEntry[]>([])
  const [weights, setWeights] = useState<Record<string, number> | null>(null)
  const [days, setDays] = useState(90)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [backfilling, setBackfilling] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  async function handleRefreshVo2max() {
    if (!user || refreshing) return
    setRefreshing(true)
    try {
      const cur = await fetchAbilityCurrent(user, true)
      setCurrent(cur)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (!user) return
    setLoading(true)
    setError(null)
    Promise.all([
      fetchAbilityCurrent(user),
      fetchAbilityHistory(user, days),
      fetchAbilityWeights(user).catch(() => null),
      fetchPbs(user).catch(() => ({ pbs: [] as PBEntry[] })),
    ])
      .then(async ([cur, hist, w, pbResp]) => {
        setCurrent(cur)
        setWeights(w?.l4_weights ?? null)
        setPbs(pbResp.pbs)
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

  // Determine which distance is the primary target.
  const targetDist = current?.target_distance ?? 'FM'
  const isHM = targetDist === 'HM'
  const primaryEstimates: RaceEstimates = isHM
    ? (current?.half_marathon_estimates ?? EMPTY_ESTIMATES)
    : (current?.marathon_estimates ?? EMPTY_ESTIMATES)
  const secondaryEstimates: RaceEstimates = isHM
    ? (current?.marathon_estimates ?? EMPTY_ESTIMATES)
    : (current?.half_marathon_estimates ?? EMPTY_ESTIMATES)
  const primaryLabel = isHM ? 'HALF MARATHON' : 'MARATHON'
  const primaryTag = isHM ? '半马' : '全马'
  const secondaryTag = isHM ? '全马' : '半马'

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 sm:px-8 sm:py-8">
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-accent-red/10 border border-accent-red/30 rounded-xl p-6 text-center">
          <p className="text-sm font-mono text-accent-red">加载失败: {error}</p>
        </div>
      ) : current ? (
        <div className="animate-fade-in">
          <ViewHead
            eyebrow="训练能力 · 90 天数据"
            title="你的跑步能力画像"
            lede="基于过去 90 天的训练数据 + 训练负荷计算"
          />

          {/* Primary distance — the user's target race */}
          <AbilityHero
            estimates={primaryEstimates}
            date={current.date}
            targetS={current.target_s}
            targetLabel={current.target_label}
            distanceLabel={primaryLabel}
          />

          <AbilityTriptych estimates={primaryEstimates} distanceLabel={primaryTag} />

          {/* Secondary distance — always show the other race distance */}
          {secondaryEstimates.race_s != null && (
            <div className="mb-6">
              <p className="text-xs font-mono text-text-muted tracking-widest mb-3 uppercase">
                {secondaryTag} Race Estimate
              </p>
              <AbilityTriptych estimates={secondaryEstimates} distanceLabel={secondaryTag} />
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <AbilityRadar current={current} weights={weights} />
            <Vo2maxPanel
              vo2max={current.l3_dimensions.vo2max}
              dataSource={current.source}
              onRefresh={handleRefreshVo2max}
              refreshing={refreshing}
            />
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

          <div className="mb-6">
            <AbilityPBTable pbs={pbs} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
