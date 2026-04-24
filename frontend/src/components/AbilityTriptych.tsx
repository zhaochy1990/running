import type { MarathonEstimates } from '../api'
import { fmtHMS } from '../lib/fmt'

export default function AbilityTriptych({ estimates }: { estimates: MarathonEstimates }) {
  const racePct = estimates.race_day_boost_pct
  const bestPct = estimates.best_case_boost_pct

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      <Card
        label="训练估算"
        sublabel="Training Estimate"
        value={fmtHMS(estimates.training_s)}
        detail="训练实力 · 未加比赛日增益"
        highlighted={false}
      />
      <Card
        label="比赛估算"
        sublabel="Race Estimate"
        value={fmtHMS(estimates.race_s)}
        detail={`完美赛日 · 减量 ${racePct != null ? `+${racePct}%` : '增益'}`}
        highlighted={true}
      />
      <Card
        label="最佳情境"
        sublabel="Best Case"
        value={fmtHMS(estimates.best_case_s)}
        detail={`理论上限 · ${bestPct != null ? `+${bestPct}%` : '完美执行'}`}
        highlighted={false}
      />
    </div>
  )
}

function Card({ label, sublabel, value, detail, highlighted }: {
  label: string; sublabel: string; value: string; detail: string; highlighted: boolean
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
      <p className="text-xs font-mono text-text-muted mt-2 leading-relaxed">{detail}</p>
    </div>
  )
}
