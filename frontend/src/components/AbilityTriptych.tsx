import type { RaceEstimates } from '../api'
import { fmtHMS, fmtPace } from '../lib/fmt'

const MARATHON_KM = 42.195
const HALF_MARATHON_KM = 21.0975

export default function AbilityTriptych({
  estimates,
  distanceLabel,
}: {
  estimates: RaceEstimates
  /** e.g. '全马' or '半马' */
  distanceLabel?: string
}) {
  const racePct = estimates.race_day_boost_pct
  const bestPct = estimates.best_case_boost_pct
  const tag = distanceLabel ? ` (${distanceLabel})` : ''
  const distKm = distanceLabel === '半马' ? HALF_MARATHON_KM : MARATHON_KM

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      <Card
        label={`训练估算${tag}`}
        sublabel="Training Estimate"
        value={fmtHMS(estimates.training_s)}
        pace={fmtPace(estimates.training_s, distKm)}
        detail="训练实力 · 未加比赛日增益"
        highlighted={false}
      />
      <Card
        label={`比赛估算${tag}`}
        sublabel="Race Estimate"
        value={fmtHMS(estimates.race_s)}
        pace={fmtPace(estimates.race_s, distKm)}
        detail={`完美赛日 · 减量 ${racePct != null ? `+${racePct}%` : '增益'}`}
        highlighted={true}
      />
      <Card
        label={`最佳情境${tag}`}
        sublabel="Best Case"
        value={fmtHMS(estimates.best_case_s)}
        pace={fmtPace(estimates.best_case_s, distKm)}
        detail={`理论上限 · ${bestPct != null ? `+${bestPct}%` : '完美执行'}`}
        highlighted={false}
      />
    </div>
  )
}

function Card({ label, sublabel, value, pace, detail, highlighted }: {
  label: string; sublabel: string; value: string; pace: string; detail: string; highlighted: boolean
}) {
  return (
    <div
      className={`rounded-2xl p-6 border transition-all ${
        highlighted
          ? 'bg-accent-green/8 border-accent-green/40'
          : 'bg-bg-card border-border-subtle'
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className={`text-xs font-medium ${highlighted ? 'text-accent-green' : 'text-text-secondary'}`}>
            {label}
          </p>
          <p className="text-xs font-mono text-text-muted">{sublabel}</p>
        </div>
        <div
          className="w-2 h-2 rounded-full shrink-0 mt-1"
          style={{
            backgroundColor: highlighted ? '#00a85a' : '#8888a0',
            boxShadow: `0 0 8px ${highlighted ? '#00a85a40' : '#8888a020'}`,
          }}
        />
      </div>
      <p
        className="text-3xl font-bold font-mono tracking-tight"
        style={{ color: highlighted ? '#00a85a' : '#1a1c2e' }}
      >
        {value}
      </p>
      {pace !== '—' && (
        <p
          className="text-sm font-mono mt-1"
          style={{ color: highlighted ? '#00a85a' : '#6b6b80' }}
        >
          配速 {pace}
        </p>
      )}
      <p className="text-xs font-mono text-text-muted mt-2 leading-relaxed">{detail}</p>
    </div>
  )
}
