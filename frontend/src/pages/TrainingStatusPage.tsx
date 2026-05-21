import { useEffect, useState } from 'react'
import {
  ResponsiveContainer, AreaChart, Area,
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

// === Task 10: ZonesRow ===
function EmptyZones() {
  return (
    <div className="text-xs font-mono text-text-muted py-6 text-center">
      暂无 STRIDE 校准数据
      <br />
      需先完成一定次数的跑步活动
    </div>
  )
}

function ZonesRow({ zones }: { zones: StrideZonesResponse | null }) {
  const hasData = !!zones?.threshold && zones.pace_zones.length > 0 && zones.hr_zones.length > 0

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      <ChartCard title="配速区间" sublabel="STRIDE-derived from threshold pace">
        {hasData ? (
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-text-faint border-b border-border-subtle">
                <th className="text-left py-1">Zone</th>
                <th className="text-left py-1">名称</th>
                <th className="text-right py-1">慢边</th>
                <th className="text-right py-1">快边</th>
              </tr>
            </thead>
            <tbody>
              {zones!.pace_zones.map((z) => (
                <tr key={z.name} className="border-b border-border-subtle/50 last:border-0">
                  <td className="py-1.5 text-accent-green">{z.name}</td>
                  <td className="py-1.5 text-text-primary">{z.label}</td>
                  <td className="py-1.5 text-right text-text-muted">{z.lower_pace ?? '—'}</td>
                  <td className="py-1.5 text-right text-text-muted">{z.upper_pace ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyZones />
        )}
      </ChartCard>

      <ChartCard title="心率区间" sublabel="STRIDE-derived from threshold HR">
        {hasData ? (
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-text-faint border-b border-border-subtle">
                <th className="text-left py-1">Zone</th>
                <th className="text-left py-1">名称</th>
                <th className="text-right py-1">下限</th>
                <th className="text-right py-1">上限</th>
              </tr>
            </thead>
            <tbody>
              {zones!.hr_zones.map((z) => (
                <tr key={z.name} className="border-b border-border-subtle/50 last:border-0">
                  <td className="py-1.5 text-accent-amber">{z.name}</td>
                  <td className="py-1.5 text-text-primary">{z.label}</td>
                  <td className="py-1.5 text-right text-text-muted">{z.lower_bpm ?? '—'}</td>
                  <td className="py-1.5 text-right text-text-muted">{z.upper_bpm ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyZones />
        )}
      </ChartCard>
    </div>
  )
}

// === Task 11: TrainingLoadSection ===
function LoadStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex flex-col">
      <div className="text-[10px] font-mono text-text-faint">{label}</div>
      <div className="text-lg font-mono font-medium" style={{ color }}>{value}</div>
    </div>
  )
}

function TrainingLoadSection({ load }: { load: StrideTrainingLoadResponse | null }) {
  const cur = load?.current
  const series = (load?.series ?? []).map((r) => ({
    ...r,
    dateLabel: formatDateShort(r.date),
  }))

  const stateLabel = (() => {
    const ratio = cur?.load_ratio
    if (ratio == null) return '—'
    if (ratio < 0.8) return '恢复期'
    if (ratio < 1.0) return '正常训练'
    if (ratio < 1.3) return '产出期'
    return '过度负荷'
  })()

  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-4 mb-6">
      <div className="text-xs font-mono text-text-muted mb-2">训练负荷（STRIDE）</div>
      {!cur ? (
        <div className="text-xs font-mono text-text-muted py-6 text-center">暂无训练负荷数据</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            <LoadStat label="Acute" value={cur.acute_load?.toFixed(1) ?? '—'} color="#d97706" />
            <LoadStat label="Chronic" value={cur.chronic_load?.toFixed(1) ?? '—'} color="#0097a7" />
            <LoadStat
              label="Form"
              value={cur.form != null ? (cur.form > 0 ? `+${cur.form.toFixed(1)}` : cur.form.toFixed(1)) : '—'}
              color={cur.form != null && cur.form < -10 ? '#d32f2f' : '#00a85a'}
            />
            <LoadStat label="Ratio" value={cur.load_ratio?.toFixed(2) ?? '—'} color="#7a4dd4" />
            <LoadStat label="状态" value={stateLabel} color="#1a1c2e" />
          </div>
          <div className="text-[11px] font-mono text-text-muted mb-2">
            Readiness: <span className="text-text-primary">{cur.readiness_gate ?? '—'}</span>
            {cur.readiness_reasons.length > 0 && (
              <span className="ml-2 text-text-faint">· {cur.readiness_reasons.join(' · ')}</span>
            )}
          </div>
          {series.length > 0 && (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid {...GRID_STYLE} />
                <XAxis dataKey="dateLabel" tick={AXIS_TICK} />
                <YAxis tick={AXIS_TICK} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'JetBrains Mono' }} />
                <Area type="monotone" dataKey="acute_load" name="Acute" stroke="#d97706" fill="#d97706" fillOpacity={0.15} />
                <Area type="monotone" dataKey="chronic_load" name="Chronic" stroke="#0097a7" fill="#0097a7" fillOpacity={0.15} />
                <Area type="monotone" dataKey="form" name="Form" stroke="#00a85a" fill="#00a85a" fillOpacity={0.1} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </>
      )}
    </div>
  )
}

// === Task 12: DataStatusFooter ===
function DataStatusFooter({
  zones, load,
}: {
  zones: StrideZonesResponse | null
  load: StrideTrainingLoadResponse | null
}) {
  return (
    <div className="text-[10px] font-mono text-text-faint border-t border-border-subtle pt-3 mt-4 space-y-0.5">
      <div>
        Calibration: {zones?.threshold?.as_of_date ?? '—'} · 来源：STRIDE 自研算法
      </div>
      <div>Training load latest: {load?.current?.date ?? '—'}</div>
      <div>RHR / HRV: 来自手表原始读数（COROS / Garmin）</div>
    </div>
  )
}
