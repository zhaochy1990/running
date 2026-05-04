import type { IntensitySummary } from '../api'

export interface WeeklyIntensityCardProps {
  summary: IntensitySummary | undefined
}

function fmtKm(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${v.toFixed(1)} km`
}

/** Compact 3-stat strip rendered above the calendar grid:
 *   - 本周跑量    (run-only mileage; excludes rides / strength / swims)
 *   - 低强度 Z1+Z2 (km in HR zones 1–2, time-fraction proxy)
 *   - 高强度 Z4+Z5 (km in HR zones 4–5)
 *
 * When the server can't compute zone data for the week (no synced HR zones
 * for any run yet) the low/high cells fall back to "—" and a small note
 * explains why; total km still renders since it doesn't need zones.
 */
export default function WeeklyIntensityCard({ summary }: WeeklyIntensityCardProps) {
  if (!summary) return null

  const totalKm = fmtKm(summary.total_run_km)
  const lowKm = fmtKm(summary.low_km)
  const highKm = fmtKm(summary.high_km)
  const lowPct =
    summary.has_zone_data && summary.total_run_km > 0 && summary.low_km != null
      ? Math.round((summary.low_km / summary.total_run_km) * 100)
      : null
  const highPct =
    summary.has_zone_data && summary.total_run_km > 0 && summary.high_km != null
      ? Math.round((summary.high_km / summary.total_run_km) * 100)
      : null

  return (
    <div
      data-testid="weekly-intensity-card"
      className="grid grid-cols-3 gap-2 rounded-xl border border-border-subtle bg-bg-card px-4 py-3 sm:gap-4"
    >
      <Stat label="本周跑量" value={totalKm} accent="green" />
      <Stat
        label="低强度 Z1+Z2"
        value={lowKm}
        sub={lowPct != null ? `${lowPct}%` : undefined}
        accent="cyan"
      />
      <Stat
        label="高强度 Z4+Z5"
        value={highKm}
        sub={highPct != null ? `${highPct}%` : undefined}
        accent="amber"
      />
      {!summary.has_zone_data && summary.total_run_km > 0 && (
        <p className="col-span-3 text-[11px] font-mono text-text-muted">
          尚无心率分区数据 — 同步本周训练后再次刷新
        </p>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string
  sub?: string
  accent: 'green' | 'cyan' | 'amber'
}) {
  const accentColor =
    accent === 'green'
      ? 'text-accent-green'
      : accent === 'cyan'
        ? 'text-accent-cyan'
        : 'text-accent-amber'
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-[11px] font-mono uppercase tracking-wider text-text-muted">
        {label}
      </p>
      <p className={`text-base font-mono font-semibold ${accentColor}`}>
        {value}
        {sub && (
          <span className="ml-1.5 text-xs font-normal text-text-muted">
            {sub}
          </span>
        )}
      </p>
    </div>
  )
}
