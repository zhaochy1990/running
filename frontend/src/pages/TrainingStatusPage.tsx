import { useEffect, useState } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts'
import {
  getHealth, getHrv, getStrideZones, getStrideTrainingLoad,
  type HealthRecord, type HrvDailyRecord,
  type StrideZonesResponse, type StrideTrainingLoadResponse,
} from '../api'
import { useUser } from '../UserContextValue'
import ViewHead from '../components/ViewHead'

const AXIS_TICK = { fontSize: 10, fontFamily: 'JetBrains Mono', fill: '#8888a0' }
const TOOLTIP_STYLE = {
  contentStyle: { background: '#ffffff', border: '1px solid #d8dae5', borderRadius: 8, fontFamily: 'JetBrains Mono', fontSize: 12, color: '#1a1c2e' },
  labelStyle: { color: '#8888a0' },
}
const GRID_STYLE = { stroke: '#e8eaf0', strokeDasharray: '3 3' }

type DaysWindow = 14 | 30 | 60 | 90

function formatDateShort(iso: string): string {
  if (!iso || iso.length < 10) return iso
  return `${parseInt(iso.slice(5, 7), 10)}/${parseInt(iso.slice(8, 10), 10)}`
}

export default function TrainingStatusPage() {
  const { user } = useUser()
  const [days, setDays] = useState<DaysWindow>(30)
  const [health, setHealth] = useState<{ health: HealthRecord[]; rhr_baseline: number | null } | null>(null)
  const [hrv, setHrv] = useState<{ hrv: HrvDailyRecord[] } | null>(null)
  const [zones, setZones] = useState<StrideZonesResponse | null>(null)
  const [load, setLoad] = useState<StrideTrainingLoadResponse | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoaded(false)
    setError(null)
    Promise.all([
      getHealth(user, 90),
      getHrv(user, 90),
      getStrideZones(user),
      getStrideTrainingLoad(user, days),
    ])
      .then(([h, hv, z, ld]) => {
        if (cancelled) return
        setHealth({ health: h.health, rhr_baseline: h.rhr_baseline })
        setHrv({ hrv: hv.hrv })
        setZones(z)
        setLoad(ld)
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => { cancelled = true }
  }, [user, days])

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 sm:px-8 sm:py-8 animate-fade-in">
      <div className="flex items-start justify-between gap-4 mb-4">
        <ViewHead eyebrow="STRIDE 自研算法" title="训练状态" lede="Threshold · Zones · Training Load" />
        <TimeRangeToggle value={days} onChange={setDays} />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 mb-4 text-sm font-mono">
          加载失败：{error}
        </div>
      )}

      <MetricsRow health={health} hrv={hrv} zones={zones} />
      <TrendsRow health={health} hrv={hrv} days={days} />
      <ZonesRow zones={zones} />
      <TrainingLoadSection load={load} />
      <DataStatusFooter zones={zones} load={load} />
    </div>
  )
}

function TimeRangeToggle({ value, onChange }: { value: DaysWindow; onChange: (d: DaysWindow) => void }) {
  const opts: DaysWindow[] = [14, 30, 60, 90]
  return (
    <div className="inline-flex rounded-md border border-border-subtle bg-bg-card p-0.5">
      {opts.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => onChange(d)}
          className={`px-3 py-1 text-xs font-mono rounded ${
            value === d ? 'bg-accent-green/15 text-accent-green' : 'text-text-muted hover:text-text-primary'
          }`}
        >
          {d}d
        </button>
      ))}
    </div>
  )
}

// === Task 8: MetricsRow ===
function MetricCard({
  label, sublabel, value, unit, baseline, color,
}: {
  label: string
  sublabel: string
  value: string
  unit: string
  baseline?: string | null
  color: string
}) {
  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-4 flex flex-col gap-1">
      <div className="text-xs font-mono text-text-muted">{label}</div>
      <div className="text-[10px] font-mono text-text-faint">{sublabel}</div>
      <div className="flex items-baseline gap-1 mt-1">
        <span className="text-2xl font-mono font-medium" style={{ color }}>{value}</span>
        <span className="text-xs font-mono text-text-muted">{unit}</span>
      </div>
      {baseline != null && (
        <div className="text-[10px] font-mono text-text-muted mt-0.5">基线 {baseline}</div>
      )}
    </div>
  )
}

function MetricsRow({
  health, hrv, zones,
}: {
  health: { health: HealthRecord[]; rhr_baseline: number | null } | null
  hrv: { hrv: HrvDailyRecord[] } | null
  zones: StrideZonesResponse | null
}) {
  const latestRhr = health?.health.find((r) => r.rhr != null)?.rhr ?? null
  const rhrBaseline = health?.rhr_baseline ?? null
  const latestHrv = hrv?.hrv.slice().reverse().find((r) => r.last_night_avg != null)?.last_night_avg ?? null
  const threshold = zones?.threshold

  const pacePerKm = threshold?.pace_per_km_sec
  const paceStr = pacePerKm != null ? `${Math.floor(pacePerKm / 60)}:${String(pacePerKm % 60).padStart(2, '0')}` : '—'
  const hrStr = threshold?.hr_bpm != null ? String(Math.round(threshold.hr_bpm)) : '—'

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <MetricCard
        label="RHR" sublabel="Resting HR · 手表读数"
        value={latestRhr != null ? String(latestRhr) : '—'}
        unit="bpm"
        baseline={rhrBaseline != null ? `${rhrBaseline} bpm` : null}
        color="#0097a7"
      />
      <MetricCard
        label="HRV" sublabel="Last-night avg · 手表读数"
        value={latestHrv != null ? String(latestHrv) : '—'}
        unit="ms"
        color="#7a4dd4"
      />
      <MetricCard
        label="阈值配速" sublabel="STRIDE Threshold Pace"
        value={paceStr}
        unit="/km"
        baseline={threshold?.speed_confidence ? `置信 ${threshold.speed_confidence}` : null}
        color="#00a85a"
      />
      <MetricCard
        label="阈值心率" sublabel="STRIDE Threshold HR"
        value={hrStr}
        unit="bpm"
        baseline={threshold?.hr_confidence ? `置信 ${threshold.hr_confidence}` : null}
        color="#d97706"
      />
    </div>
  )
}

// === Task 9: TrendsRow ===
function ChartCard({ title, sublabel, children }: { title: string; sublabel: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-4">
      <div className="text-xs font-mono text-text-muted">{title}</div>
      <div className="text-[10px] font-mono text-text-faint mb-2">{sublabel}</div>
      {children}
    </div>
  )
}

function EmptyChart({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center h-[200px] text-xs font-mono text-text-muted">{text}</div>
  )
}

function TrendsRow({
  health, hrv, days,
}: {
  health: { health: HealthRecord[]; rhr_baseline: number | null } | null
  hrv: { hrv: HrvDailyRecord[] } | null
  days: DaysWindow
}) {
  const rhrData = (health?.health ?? [])
    .slice()
    .reverse()
    .filter((r) => r.rhr != null)
    .slice(-days)
    .map((r) => ({
      date: r.date,
      dateLabel: formatDateShort(r.date.length === 8 ? `${r.date.slice(0,4)}-${r.date.slice(4,6)}-${r.date.slice(6,8)}` : r.date),
      rhr: r.rhr,
    }))

  const hrvData = (hrv?.hrv ?? [])
    .slice()
    .filter((r) => r.last_night_avg != null)
    .slice(-days)
    .map((r) => ({
      date: r.date,
      dateLabel: formatDateShort(r.date),
      hrv: r.last_night_avg,
    }))

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      <ChartCard title="RHR 趋势" sublabel={`最近 ${days} 天 · 手表读数`}>
        {rhrData.length === 0 ? (
          <EmptyChart text="暂无 RHR 数据" />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={rhrData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="dateLabel" tick={AXIS_TICK} />
              <YAxis tick={AXIS_TICK} domain={['dataMin - 2', 'dataMax + 2']} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Area type="monotone" dataKey="rhr" stroke="#0097a7" fill="#0097a7" fillOpacity={0.15} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
      <ChartCard title="HRV 趋势" sublabel={`最近 ${days} 天 · 手表读数`}>
        {hrvData.length === 0 ? (
          <EmptyChart text="暂无 HRV 数据" />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={hrvData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="dateLabel" tick={AXIS_TICK} />
              <YAxis tick={AXIS_TICK} domain={['dataMin - 5', 'dataMax + 5']} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Area type="monotone" dataKey="hrv" stroke="#7a4dd4" fill="#7a4dd4" fillOpacity={0.15} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </div>
  )
}

// Placeholders for tasks 10-12
function ZonesRow(_props: { zones: any }) { return <div data-section="zones" /> }
function TrainingLoadSection(_props: { load: any }) { return <div data-section="load" /> }
function DataStatusFooter(_props: { zones: any; load: any }) { return <div data-section="footer" /> }
