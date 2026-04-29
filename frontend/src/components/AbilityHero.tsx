import type { MarathonEstimates } from '../api'
import { fmtHMS, fmtGap } from '../lib/fmt'

export default function AbilityHero({
  estimates, date, targetS, targetLabel,
}: {
  estimates: MarathonEstimates
  date: string
  targetS?: number | null
  targetLabel?: string | null
}) {
  const raceS = estimates.race_s
  const hasTarget = targetS != null && Number.isFinite(targetS)
  const gap = raceS != null && hasTarget ? raceS - targetS : null
  const onPace = gap != null && gap <= 0

  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-10 mb-6 text-center animate-fade-in">
      <p className="text-xs font-mono text-text-muted tracking-widest mb-3">
        MARATHON RACE ESTIMATE · {date}
      </p>
      <p
        className="text-7xl md:text-8xl font-bold font-mono tracking-tight leading-none"
        style={{ color: onPace ? '#00a85a' : '#1a1c2e' }}
      >
        {fmtHMS(raceS)}
      </p>
      {hasTarget && targetLabel ? (
        <div className="mt-5 flex items-center justify-center gap-4 flex-wrap">
          <span className="text-sm font-mono text-text-secondary">
            目标 {targetLabel}
          </span>
          <span
            className="text-sm font-mono font-semibold px-2.5 py-1 rounded"
            style={{
              color: onPace ? '#00a85a' : '#d32f2f',
              backgroundColor: (onPace ? '#00a85a' : '#d32f2f') + '15',
            }}
          >
            {gap != null ? `${onPace ? '已达 ' : ''}${fmtGap(gap)}` : '—'}
          </span>
        </div>
      ) : null}
      <p className="text-xs font-mono text-text-muted mt-4 leading-relaxed">
        完美赛日 / 未减量 · Race-day execution assuming taper & perfect conditions
      </p>
    </div>
  )
}
