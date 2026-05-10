import type { RaceEstimates } from '../api'
import { fmtHMS, fmtGap, fmtPace } from '../lib/fmt'

const MARATHON_KM = 42.195
const HALF_MARATHON_KM = 21.0975

export default function AbilityHero({
  estimates, date, targetS, targetLabel, distanceLabel,
}: {
  estimates: RaceEstimates
  date: string
  targetS?: number | null
  targetLabel?: string | null
  /** 'MARATHON' or 'HALF MARATHON' — drives the header text. */
  distanceLabel?: string
}) {
  const label = distanceLabel || 'MARATHON'
  const raceS = estimates.race_s
  const hasTarget = targetS != null && Number.isFinite(targetS)
  const gap = raceS != null && hasTarget ? raceS - targetS : null
  const onPace = gap != null && gap <= 0
  const distKm = label === 'HALF MARATHON' ? HALF_MARATHON_KM : MARATHON_KM
  const pace = fmtPace(raceS, distKm)

  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-10 mb-6 text-center animate-fade-in">
      <p className="text-xs font-mono text-text-muted tracking-widest mb-3">
        {label} RACE ESTIMATE · {date}
      </p>
      <p
        className="text-7xl md:text-8xl font-bold font-mono tracking-tight leading-none"
        style={{ color: onPace ? '#00a85a' : '#1a1c2e' }}
      >
        {fmtHMS(raceS)}
      </p>
      {pace !== '—' && (
        <p
          className="text-lg font-mono mt-2"
          style={{ color: onPace ? '#00a85a' : '#6b6b80' }}
        >
          配速 {pace}
        </p>
      )}
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
