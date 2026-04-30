import { useEffect, useState } from 'react'
import {
  ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceArea,
} from 'recharts'
import { getHrv, type HealthRecord, type HrvDailyRecord, type HrvSummary } from '../../api'

const AXIS_TICK = { fontSize: 10, fontFamily: 'JetBrains Mono', fill: '#8888a0' }
const TOOLTIP_STYLE = {
  contentStyle: {
    background: '#ffffff',
    border: '1px solid #d8dae5',
    borderRadius: 8,
    fontFamily: 'JetBrains Mono',
    fontSize: 12,
    color: '#1a1c2e',
  },
  labelStyle: { color: '#8888a0' },
}
const GRID_STYLE = { stroke: '#e8eaf0', strokeDasharray: '3 3' }


function formatHM(seconds: number | null): string {
  if (seconds == null) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h${m.toString().padStart(2, '0')}m` : `${m}m`
}


function sleepScoreColor(score: number | null): string {
  if (score == null) return '#8888a0'
  if (score >= 80) return '#00a85a'
  if (score >= 60) return '#ffab00'
  return '#d32f2f'
}


function bodyBatteryColor(low: number | null): string {
  if (low == null) return '#8888a0'
  if (low > 30) return '#00a85a'
  if (low > 15) return '#ffab00'
  return '#d32f2f'
}


function stressColor(avg: number | null): string {
  if (avg == null) return '#8888a0'
  if (avg < 25) return '#00a85a'
  if (avg < 50) return '#ffab00'
  return '#d32f2f'
}


function hrvStatusLabel(status: string | null): string {
  if (!status) return '—'
  const map: Record<string, string> = {
    BALANCED: '平衡', UNBALANCED: '失衡', POOR: '低位',
    LOW: '过低', NO_STATUS: '无数据',
  }
  return map[status] ?? status
}


function hrvStatusColor(status: string | null): string {
  if (!status) return '#8888a0'
  const map: Record<string, string> = {
    BALANCED: '#00a85a', UNBALANCED: '#ffab00',
    POOR: '#d32f2f', LOW: '#d32f2f', NO_STATUS: '#8888a0',
  }
  return map[status] ?? '#8888a0'
}


function formatDate(dateStr: string): string {
  if (!dateStr) return dateStr
  // ISO 'YYYY-MM-DD' → 'M/D'
  if (dateStr.length === 10 && dateStr[4] === '-') {
    const m = parseInt(dateStr.slice(5, 7), 10)
    const d = parseInt(dateStr.slice(8, 10), 10)
    return `${m}/${d}`
  }
  return dateStr
}


/**
 * Garmin-only extras: Sleep / Body Battery / Stress cards + HRV daily trend chart.
 *
 * Renders nothing when the latest record has no Garmin-specific data
 * (i.e. COROS users see a clean health page unchanged from before).
 */
export default function GarminExtrasSection({
  user, latest, days,
}: {
  user: string
  latest: HealthRecord | null
  days: number
}) {
  const [hrvRecords, setHrvRecords] = useState<HrvDailyRecord[]>([])
  const [hrvSummary, setHrvSummary] = useState<HrvSummary | null>(null)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    getHrv(user, days)
      .then((res) => {
        if (cancelled) return
        setHrvRecords(res.hrv)
        setHrvSummary(res.summary)
      })
      .catch(() => {/* HRV is optional; ignore failures */})
    return () => { cancelled = true }
  }, [user, days])

  // Hide entirely for users with no Garmin data anywhere on this row
  const hasAnyData = latest && (
    latest.sleep_total_s != null ||
    latest.body_battery_high != null ||
    latest.stress_avg != null ||
    hrvRecords.length > 0
  )
  if (!hasAnyData) return null

  const chartData = [...hrvRecords].map((r) => ({
    ...r,
    dateLabel: formatDate(r.date),
  }))

  const hrvBalancedLow = hrvSummary?.baseline_balanced_low ?? null
  const hrvBalancedHigh = hrvSummary?.baseline_balanced_upper ?? null

  return (
    <div className="mb-6">
      <div className="flex items-baseline gap-2 mb-3">
        <h3 className="text-sm font-semibold text-text-primary">手表扩展数据</h3>
        <p className="text-xs font-mono text-text-muted">Watch Extras · Garmin</p>
      </div>

      {/* Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <ExtraCard
          label="昨夜睡眠"
          sublabel="Sleep"
          value={formatHM(latest?.sleep_total_s ?? null)}
          color={sleepScoreColor(latest?.sleep_score ?? null)}
          detail={
            latest?.sleep_score != null
              ? `Score ${latest.sleep_score}`
              : (latest?.sleep_deep_s != null
                  ? `深 ${formatHM(latest.sleep_deep_s)} · REM ${formatHM(latest.sleep_rem_s)}`
                  : '—')
          }
        />
        <ExtraCard
          label="Body Battery"
          sublabel="Energy"
          value={
            latest?.body_battery_high != null && latest?.body_battery_low != null
              ? `${latest.body_battery_low} ~ ${latest.body_battery_high}`
              : '—'
          }
          color={bodyBatteryColor(latest?.body_battery_low ?? null)}
          detail={
            latest?.body_battery_low != null
              ? (latest.body_battery_low > 30 ? '储备良好' : latest.body_battery_low > 15 ? '储备不足' : '严重耗尽')
              : ''
          }
        />
        <ExtraCard
          label="日均压力"
          sublabel="Stress"
          value={latest?.stress_avg != null ? `${latest.stress_avg}` : '—'}
          color={stressColor(latest?.stress_avg ?? null)}
          detail={
            latest?.stress_avg != null
              ? (latest.stress_avg < 25 ? '低压力' : latest.stress_avg < 50 ? '中等' : '高压力')
              : ''
          }
        />
        <ExtraCard
          label="HRV 状态"
          sublabel="Last Night"
          value={hrvSummary?.last_night_avg != null ? `${hrvSummary.last_night_avg}ms` : '—'}
          color={hrvStatusColor(hrvSummary?.status ?? null)}
          detail={
            hrvSummary?.status
              ? hrvStatusLabel(hrvSummary.status)
              : (hrvSummary?.weekly_avg != null ? `7日均 ${hrvSummary.weekly_avg}` : '')
          }
        />
      </div>

      {/* HRV trend chart */}
      {chartData.length > 0 && (
        <div className="bg-bg-card border border-border-subtle rounded-2xl p-5">
          <div className="mb-4 flex items-baseline justify-between">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">HRV 趋势</h3>
              <p className="text-xs font-mono text-text-muted">Heart Rate Variability · Last Night Avg</p>
            </div>
            {hrvBalancedLow != null && hrvBalancedHigh != null && (
              <p className="text-xs font-mono text-text-muted">
                平衡带 {hrvBalancedLow}-{hrvBalancedHigh}ms
              </p>
            )}
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
              <defs>
                <linearGradient id="gradHrv" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0097a7" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#0097a7" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="dateLabel" tick={AXIS_TICK} axisLine={{ stroke: '#d8dae5' }} tickLine={false} />
              <YAxis domain={['dataMin - 10', 'dataMax + 10']} tick={AXIS_TICK} axisLine={false} tickLine={false} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: unknown) => [`${v} ms`, 'HRV']} />
              {hrvBalancedLow != null && hrvBalancedHigh != null && (
                <ReferenceArea
                  y1={hrvBalancedLow}
                  y2={hrvBalancedHigh}
                  fill="#00a85a"
                  fillOpacity={0.06}
                  stroke="#00a85a"
                  strokeOpacity={0.2}
                  strokeDasharray="3 3"
                />
              )}
              <Area
                type="monotone"
                dataKey="last_night_avg"
                stroke="#0097a7"
                strokeWidth={1.5}
                fill="url(#gradHrv)"
                dot={false}
                activeDot={{ r: 3, fill: '#0097a7', stroke: '#fff', strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}


function ExtraCard({
  label, sublabel, value, color, detail,
}: {
  label: string
  sublabel: string
  value: string
  color: string
  detail: string
}) {
  return (
    <div className="bg-bg-card border border-border-subtle rounded-xl p-4 hover:bg-bg-card-hover transition-all duration-200">
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-xs font-medium text-text-secondary">{label}</p>
          <p className="text-xs font-mono text-text-muted">{sublabel}</p>
        </div>
        <div className="w-2 h-2 rounded-full shrink-0 mt-1"
          style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}40` }} />
      </div>
      <p className="text-2xl font-bold font-mono tracking-tight" style={{ color }}>
        {value}
      </p>
      {detail && <p className="text-xs font-mono text-text-muted mt-1">{detail}</p>}
    </div>
  )
}
