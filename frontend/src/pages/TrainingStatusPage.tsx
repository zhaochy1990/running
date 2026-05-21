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

// === Placeholders filled by subsequent tasks (8-12) ===
function MetricsRow(_props: { health: any; hrv: any; zones: any }) { return <div data-section="metrics" /> }
function TrendsRow(_props: { health: any; hrv: any; days: DaysWindow }) { return <div data-section="trends" /> }
function ZonesRow(_props: { zones: any }) { return <div data-section="zones" /> }
function TrainingLoadSection(_props: { load: any }) { return <div data-section="load" /> }
function DataStatusFooter(_props: { zones: any; load: any }) { return <div data-section="footer" /> }
