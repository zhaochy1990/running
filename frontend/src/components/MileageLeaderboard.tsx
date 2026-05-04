import { useEffect, useState } from 'react'
import {
  getTeamMileage,
  type MileageLeaderboardData,
  type MileagePeriod,
} from '../api'

interface MileageLeaderboardProps {
  teamId: string
}

const RANK_PREFIX = ['🥇', '🥈', '🥉']

const PERIOD_LABELS: Record<MileagePeriod, string> = {
  month: '本月榜',
  week: '本周榜',
}

const EMPTY_HINT: Record<MileagePeriod, string> = {
  month: '本月还没人跑过',
  week: '本周还没人跑过',
}

export default function MileageLeaderboard({ teamId }: MileageLeaderboardProps) {
  const [period, setPeriod] = useState<MileagePeriod>('month')
  const [data, setData] = useState<MileageLeaderboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    getTeamMileage(teamId, period)
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : '加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [teamId, period])

  return (
    <section>
      <div className="flex items-center gap-2 mb-4">
        {(Object.keys(PERIOD_LABELS) as MileagePeriod[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            className={`px-3 py-1.5 text-xs font-mono rounded-md border transition-colors ${
              p === period
                ? 'border-accent-red/40 text-accent-red bg-accent-red/10'
                : 'border-border-subtle text-text-muted hover:bg-bg-card'
            }`}
            aria-pressed={p === period}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>

      {loading && (
        <div className="space-y-2" aria-live="polite" aria-busy>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-12 rounded-xl border border-border-subtle bg-bg-card animate-pulse"
            />
          ))}
        </div>
      )}

      {!loading && err && (
        <div className="px-4 py-3 rounded-lg border border-accent-red/30 bg-accent-red/5 text-sm text-accent-red font-mono">
          {err}
        </div>
      )}

      {!loading && !err && data && data.rankings.length === 0 && (
        <div className="px-4 py-8 rounded-lg border border-border-subtle text-center text-sm text-text-muted font-mono">
          {EMPTY_HINT[period]}
        </div>
      )}

      {!loading && !err && data && data.rankings.length > 0 && (
        <div className="space-y-2">
          {data.rankings.map((r, idx) => {
            const prefix = RANK_PREFIX[idx]
            const isPodium = idx < 3 && r.total_km > 0
            return (
              <div
                key={r.user_id}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors ${
                  isPodium
                    ? 'border-accent-red/30 bg-accent-red/5'
                    : 'border-border-subtle bg-bg-card'
                }`}
              >
                <div className="w-7 text-right font-mono text-sm text-text-muted">
                  {prefix ? <span className="text-base">{prefix}</span> : `#${idx + 1}`}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text-primary truncate">
                    {r.display_name}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-mono font-semibold text-accent-red">
                    {r.total_km.toFixed(1)} km
                  </div>
                  <div className="text-[11px] font-mono text-text-muted">
                    {r.activity_count} 次
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
