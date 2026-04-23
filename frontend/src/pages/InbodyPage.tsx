import { useEffect, useState } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, Legend,
} from 'recharts'
import { getInbody, getInbodySummary, type InBodyScan, type InBodySummary } from '../api'
import { useUser } from '../UserContext'

const AXIS_TICK = { fontSize: 10, fontFamily: 'JetBrains Mono', fill: '#8888a0' }
const TOOLTIP_STYLE = {
  contentStyle: { background: '#ffffff', border: '1px solid #d8dae5', borderRadius: 8, fontFamily: 'JetBrains Mono', fontSize: 12, color: '#1a1c2e' },
  labelStyle: { color: '#8888a0' },
}
const GRID_STYLE = { stroke: '#e8eaf0', strokeDasharray: '3 3' }

function formatDateShort(iso: string): string {
  // "2026-04-23" → "4/23"
  if (!iso || iso.length < 10) return iso
  return `${parseInt(iso.slice(5, 7), 10)}/${parseInt(iso.slice(8, 10), 10)}`
}

function deltaColor(delta: number | null | undefined, inverse = false): string {
  if (delta == null) return '#8888a0'
  if (delta === 0) return '#8888a0'
  const good = inverse ? delta < 0 : delta > 0
  return good ? '#00a85a' : '#d32f2f'
}

function formatDelta(v: number | null | undefined, unit = ''): string {
  if (v == null) return ''
  const s = v > 0 ? `+${v}` : `${v}`
  return `${s}${unit}`
}

export default function InbodyPage() {
  const { user } = useUser()
  const [scans, setScans] = useState<InBodyScan[]>([])
  const [summary, setSummary] = useState<InBodySummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    setLoading(true)
    Promise.all([getInbody(user), getInbodySummary(user)])
      .then(([list, sum]) => {
        setScans(list.scans)
        setSummary(sum)
      })
      .finally(() => setLoading(false))
  }, [user])

  // Charts want oldest-first
  const chartData = [...scans].reverse().map((s) => ({
    ...s,
    dateLabel: formatDateShort(s.scan_date),
  }))

  const latest = summary?.latest
  const deltas = summary?.deltas
  const checkpoints = summary?.checkpoints ?? []

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-accent-amber/30 border-t-accent-amber rounded-full animate-spin" />
        </div>
      ) : (
        <div className="animate-fade-in">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-text-primary tracking-tight">体测记录</h1>
              <p className="text-xs text-text-muted mt-1">InBody Body Composition — {scans.length} 次扫描</p>
            </div>
          </div>

          {!latest && (
            <div className="bg-bg-card border border-border-subtle rounded-2xl p-10 text-center text-text-muted">
              暂无 InBody 数据。本地通过{' '}
              <code className="font-mono text-text-primary">coros-sync inbody add</code> 录入，
              然后{' '}
              <code className="font-mono text-text-primary">coros-sync inbody push</code> 同步至线上。
            </div>
          )}

          {latest && (
            <>
              {/* Top row: 5 metric cards */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
                <MetricCard
                  label="体重" sublabel="Weight"
                  value={latest.weight_kg.toFixed(1)} unit="kg"
                  color="#0097a7"
                  delta={deltas?.weight_kg}
                  deltaUnit="kg"
                  // Weight going down is good when in deficit
                  inverse
                />
                <MetricCard
                  label="骨骼肌" sublabel="SMM"
                  value={latest.smm_kg.toFixed(1)} unit="kg"
                  color="#00a85a"
                  delta={deltas?.smm_kg}
                  deltaUnit="kg"
                />
                <MetricCard
                  label="体脂率" sublabel="Body Fat %"
                  value={latest.body_fat_pct.toFixed(1)} unit="%"
                  color={latest.body_fat_pct > 22 ? '#e68a00' : latest.body_fat_pct > 18 ? '#0097a7' : '#00a85a'}
                  delta={deltas?.body_fat_pct}
                  deltaUnit="%"
                  inverse
                />
                <MetricCard
                  label="脂肪量" sublabel="Fat Mass"
                  value={latest.fat_mass_kg.toFixed(1)} unit="kg"
                  color="#e68a00"
                  delta={deltas?.fat_mass_kg}
                  deltaUnit="kg"
                  inverse
                />
                <MetricCard
                  label="内脏脂肪" sublabel="Visceral Fat"
                  value={String(latest.visceral_fat_level)} unit="级"
                  color={latest.visceral_fat_level <= 5 ? '#00a85a' : latest.visceral_fat_level <= 9 ? '#e68a00' : '#d32f2f'}
                  delta={deltas?.visceral_fat_level}
                  deltaUnit="级"
                  inverse
                />
              </div>

              {/* 2x2 trend grid */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                <ChartCard title="体重趋势" subtitle={`Weight — 目标 ${checkpoints.map(c => c.weight_kg).join(' / ')} kg`}>
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
                      <defs>
                        <linearGradient id="gradWeight" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#0097a7" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="#0097a7" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="dateLabel" tick={AXIS_TICK} axisLine={{ stroke: '#d8dae5' }} tickLine={false} />
                      <YAxis domain={['dataMin - 1', 'dataMax + 1']} tick={AXIS_TICK} tickFormatter={formatTick} axisLine={false} tickLine={false} width={40} />
                      <Tooltip {...TOOLTIP_STYLE} formatter={(v: unknown) => [`${v} kg`, '体重']} />
                      {checkpoints.map((c, i) => (
                        <ReferenceLine
                          key={c.phase}
                          y={c.weight_kg}
                          stroke={['#7c4dff', '#0097a7', '#00a85a'][i] ?? '#8888a0'}
                          strokeDasharray="4 4"
                          strokeOpacity={0.6}
                          label={{ value: `${c.phase} ${c.weight_kg}`, position: 'right', fill: '#8888a0', fontSize: 9, fontFamily: 'JetBrains Mono' }}
                        />
                      ))}
                      <Area type="monotone" dataKey="weight_kg" stroke="#0097a7" strokeWidth={2} fill="url(#gradWeight)" dot={{ r: 3, fill: '#0097a7' }} activeDot={{ r: 5 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </ChartCard>

                <ChartCard title="骨骼肌量趋势" subtitle={`SMM — 下限 ≥ ${checkpoints[checkpoints.length - 1]?.smm_kg_min ?? 30.5} kg`}>
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
                      <defs>
                        <linearGradient id="gradSMM" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#00a85a" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="#00a85a" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="dateLabel" tick={AXIS_TICK} axisLine={{ stroke: '#d8dae5' }} tickLine={false} />
                      <YAxis domain={['dataMin - 0.3', 'dataMax + 0.3']} tick={AXIS_TICK} tickFormatter={formatTick} axisLine={false} tickLine={false} width={40} />
                      <Tooltip {...TOOLTIP_STYLE} formatter={(v: unknown) => [`${v} kg`, 'SMM']} />
                      <ReferenceLine y={30.5} stroke="#d32f2f" strokeDasharray="4 4" strokeOpacity={0.5} label={{ value: '下限 30.5', position: 'right', fill: '#d32f2f', fontSize: 10, fontFamily: 'JetBrains Mono' }} />
                      <Area type="monotone" dataKey="smm_kg" stroke="#00a85a" strokeWidth={2} fill="url(#gradSMM)" dot={{ r: 3, fill: '#00a85a' }} activeDot={{ r: 5 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </ChartCard>

                <ChartCard title="体脂率" subtitle={`Body Fat % — 目标 ${checkpoints.map(c => c.body_fat_pct).join(' / ')}%`}>
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
                      <defs>
                        <linearGradient id="gradBF" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#e68a00" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="#e68a00" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="dateLabel" tick={AXIS_TICK} axisLine={{ stroke: '#d8dae5' }} tickLine={false} />
                      <YAxis domain={['dataMin - 0.5', 'dataMax + 0.5']} tick={AXIS_TICK} tickFormatter={formatTick} axisLine={false} tickLine={false} width={40} />
                      <Tooltip {...TOOLTIP_STYLE} formatter={(v: unknown) => [`${v}%`, '体脂率']} />
                      {checkpoints.map((c, i) => (
                        <ReferenceLine
                          key={c.phase}
                          y={c.body_fat_pct}
                          stroke={['#7c4dff', '#0097a7', '#00a85a'][i] ?? '#8888a0'}
                          strokeDasharray="4 4"
                          strokeOpacity={0.5}
                        />
                      ))}
                      <Area type="monotone" dataKey="body_fat_pct" stroke="#e68a00" strokeWidth={2} fill="url(#gradBF)" dot={{ r: 3, fill: '#e68a00' }} activeDot={{ r: 5 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </ChartCard>

                <ChartCard title="脂肪量趋势" subtitle="Fat Mass kg">
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
                      <defs>
                        <linearGradient id="gradFat" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#d32f2f" stopOpacity={0.2} />
                          <stop offset="95%" stopColor="#d32f2f" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="dateLabel" tick={AXIS_TICK} axisLine={{ stroke: '#d8dae5' }} tickLine={false} />
                      <YAxis domain={['dataMin - 0.5', 'dataMax + 0.5']} tick={AXIS_TICK} tickFormatter={formatTick} axisLine={false} tickLine={false} width={40} />
                      <Tooltip {...TOOLTIP_STYLE} formatter={(v: unknown) => [`${v} kg`, '脂肪量']} />
                      <Area type="monotone" dataKey="fat_mass_kg" stroke="#d32f2f" strokeWidth={2} fill="url(#gradFat)" dot={{ r: 3, fill: '#d32f2f' }} activeDot={{ r: 5 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>

              {/* Segment analysis */}
              <SegmentAnalysis chartData={chartData} latest={latest} />

              {/* Data table */}
              <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 mt-6 animate-fade-in">
                <h3 className="text-sm font-semibold text-text-primary mb-4">
                  扫描记录
                  <span className="text-text-muted font-normal ml-2">All Scans</span>
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs font-mono">
                    <thead>
                      <tr className="border-b-2 border-border">
                        <th className="text-left py-2 px-3 text-text-primary font-semibold">日期</th>
                        <th className="text-right py-2 px-3 text-text-primary font-semibold">体重</th>
                        <th className="text-right py-2 px-3 text-text-primary font-semibold">SMM</th>
                        <th className="text-right py-2 px-3 text-text-primary font-semibold">体脂%</th>
                        <th className="text-right py-2 px-3 text-text-primary font-semibold">脂肪kg</th>
                        <th className="text-right py-2 px-3 text-text-primary font-semibold">内脏脂肪</th>
                        <th className="text-right py-2 px-3 text-text-primary font-semibold">BMR</th>
                        <th className="text-right py-2 px-3 text-text-primary font-semibold">Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scans.map((s, i) => (
                        <tr
                          key={s.scan_date}
                          className="border-b border-border-subtle hover:bg-bg-card-hover transition-colors animate-fade-in opacity-0"
                          style={{ animationDelay: `${i * 40}ms`, animationFillMode: 'forwards' }}
                        >
                          <td className="py-2 px-3 text-text-secondary">{s.scan_date}</td>
                          <td className="py-2 px-3 text-right">{s.weight_kg.toFixed(1)}</td>
                          <td className="py-2 px-3 text-right text-accent-green">{s.smm_kg.toFixed(1)}</td>
                          <td className="py-2 px-3 text-right">{s.body_fat_pct.toFixed(1)}</td>
                          <td className="py-2 px-3 text-right">{s.fat_mass_kg.toFixed(1)}</td>
                          <td className="py-2 px-3 text-right" style={{ color: s.visceral_fat_level <= 5 ? '#00a85a' : s.visceral_fat_level <= 9 ? '#e68a00' : '#d32f2f' }}>
                            {s.visceral_fat_level}
                          </td>
                          <td className="py-2 px-3 text-right text-text-muted">{s.bmr_kcal ?? '—'}</td>
                          <td className="py-2 px-3 text-right text-text-muted">{s.inbody_score ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function MetricCard({ label, sublabel, value, unit, color, delta, deltaUnit, inverse }: {
  label: string; sublabel: string; value: string; unit: string; color: string
  delta?: number | null; deltaUnit?: string; inverse?: boolean
}) {
  return (
    <div className="bg-bg-card border border-border-subtle rounded-xl p-4 hover:bg-bg-card-hover transition-all duration-200">
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-xs font-medium text-text-secondary">{label}</p>
          <p className="text-xs font-mono text-text-muted">{sublabel}</p>
        </div>
        <div className="w-2 h-2 rounded-full shrink-0 mt-1" style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}40` }} />
      </div>
      <p className="text-2xl font-bold font-mono tracking-tight" style={{ color }}>
        {value}
        {unit && <span className="text-xs font-normal text-text-muted ml-1">{unit}</span>}
      </p>
      {delta != null && (
        <p className="text-xs font-mono mt-1" style={{ color: deltaColor(delta, inverse) }}>
          {formatDelta(delta, deltaUnit ?? '')} <span className="text-text-muted">vs 上次</span>
        </p>
      )}
    </div>
  )
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <p className="text-xs font-mono text-text-muted">{subtitle}</p>
      </div>
      {children}
    </div>
  )
}

type Mode = 'lean' | 'fat' | 'pct'
type ChartRow = InBodyScan & { dateLabel: string }

const SEGMENTS: { key: string; label: string; color: string }[] = [
  { key: 'left_arm',  label: '左臂',  color: '#7c4dff' },
  { key: 'right_arm', label: '右臂',  color: '#0097a7' },
  { key: 'trunk',     label: '躯干',  color: '#e68a00' },
  { key: 'left_leg',  label: '左腿',  color: '#d32f2f' },
  { key: 'right_leg', label: '右腿',  color: '#00a85a' },
]

function pctStdColor(pct: number | null | undefined): string {
  if (pct == null) return '#8888a0'
  if (pct >= 100) return '#00a85a'
  if (pct >= 85) return '#e68a00'
  return '#d32f2f'
}

const ARM_SEGS = SEGMENTS.filter(s => s.key === 'left_arm' || s.key === 'right_arm')
const TRUNK_SEGS = SEGMENTS.filter(s => s.key === 'trunk')
const LEG_SEGS = SEGMENTS.filter(s => s.key === 'left_leg' || s.key === 'right_leg')

function formatTick(v: number | string): string {
  return Number(v).toFixed(1)
}

function SegmentTrendChart({
  chartData, segs, mode, modeUnit, yDomainPad,
}: {
  chartData: ChartRow[]; segs: typeof SEGMENTS; mode: Mode
  modeUnit: string; yDomainPad: number
}) {
  const fieldByMode = (seg: string) => {
    if (mode === 'lean') return `${seg}_smm_kg`
    if (mode === 'fat') return `${seg}_fat_kg`
    return `${seg}_pct_std`
  }

  // Compute numeric Y domain ourselves so we don't hit dataMin/dataMax string arithmetic
  const values: number[] = []
  for (const row of chartData) {
    for (const s of segs) {
      const v = (row as unknown as Record<string, number | null>)[fieldByMode(s.key)]
      if (typeof v === 'number') values.push(v)
    }
  }
  const yMin = values.length ? Math.min(...values) - yDomainPad : 0
  const yMax = values.length ? Math.max(...values) + yDomainPad : 1

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={chartData} margin={{ top: 5, right: 10, bottom: 0, left: 5 }}>
        <CartesianGrid {...GRID_STYLE} />
        <XAxis dataKey="dateLabel" tick={AXIS_TICK} axisLine={{ stroke: '#d8dae5' }} tickLine={false} />
        <YAxis
          domain={mode === 'pct' ? [60, 120] : [yMin, yMax]}
          tick={AXIS_TICK}
          tickFormatter={formatTick}
          axisLine={false}
          tickLine={false}
          width={40}
        />
        <Tooltip {...TOOLTIP_STYLE} formatter={(v: unknown, name: unknown) => [`${v} ${modeUnit}`, name as string]} />
        <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'JetBrains Mono' }} />
        {mode === 'pct' && (
          <ReferenceLine y={100} stroke="#00a85a" strokeDasharray="4 4" strokeOpacity={0.5} label={{ value: '标准', position: 'right', fill: '#00a85a', fontSize: 10, fontFamily: 'JetBrains Mono' }} />
        )}
        {segs.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={fieldByMode(s.key)}
            name={s.label}
            stroke={s.color}
            strokeWidth={1.8}
            dot={{ r: 3, fill: s.color }}
            activeDot={{ r: 5 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

function SegmentAnalysis({ chartData, latest }: { chartData: ChartRow[]; latest: InBodyScan }) {
  const [mode, setMode] = useState<Mode>('lean')

  const modeLabel = mode === 'lean' ? '肌肉量 (kg)' : mode === 'fat' ? '脂肪量 (kg)' : '% 标准'
  const modeUnit = mode === 'pct' ? '%' : 'kg'
  const split = mode !== 'pct'  // pct is already 0-120%, one chart is fine

  const latestBars = SEGMENTS.map((s) => ({
    seg: s.label,
    key: s.key,
    lean: (latest as unknown as Record<string, number | null>)[`${s.key}_smm_kg`] ?? null,
    fat: (latest as unknown as Record<string, number | null>)[`${s.key}_fat_kg`] ?? null,
    pct: (latest as unknown as Record<string, number | null>)[`${s.key}_pct_std`] ?? null,
    color: s.color,
  }))

  return (
    <div className="space-y-4">
      <div className="bg-bg-card border border-border-subtle rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">节段趋势</h3>
            <p className="text-xs font-mono text-text-muted">Segmental Trends — {modeLabel}</p>
          </div>
          <div className="flex gap-1 p-1 bg-bg-secondary rounded-lg">
            {([
              ['lean', '肌肉量'],
              ['fat', '脂肪量'],
              ['pct', '% 标准'],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setMode(k)}
                className={`px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-all ${
                  mode === k ? 'bg-accent-amber/15 text-accent-amber' : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {split ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div>
              <p className="text-xs font-mono text-text-muted mb-2">下肢 (Legs)</p>
              <SegmentTrendChart chartData={chartData} segs={LEG_SEGS} mode={mode} modeUnit={modeUnit} yDomainPad={0.3} />
            </div>
            <div>
              <p className="text-xs font-mono text-text-muted mb-2">躯干 (Trunk)</p>
              <SegmentTrendChart chartData={chartData} segs={TRUNK_SEGS} mode={mode} modeUnit={modeUnit} yDomainPad={0.5} />
            </div>
            <div>
              <p className="text-xs font-mono text-text-muted mb-2">上肢 (Arms)</p>
              <SegmentTrendChart chartData={chartData} segs={ARM_SEGS} mode={mode} modeUnit={modeUnit} yDomainPad={0.1} />
            </div>
          </div>
        ) : (
          <SegmentTrendChart chartData={chartData} segs={SEGMENTS} mode={mode} modeUnit={modeUnit} yDomainPad={2} />
        )}

        {latest.leg_smm_delta != null && Math.abs(latest.leg_smm_delta) > 0.2 && (
          <div className="mt-3 px-3 py-2 bg-accent-amber/10 border border-accent-amber/30 rounded-lg">
            <p className="text-xs font-mono text-accent-amber">
              ⚠ 最新扫描左右腿肌肉量差 {formatDelta(latest.leg_smm_delta, ' kg')}（右 − 左）。
              仅是肌肉量差异；功能性耐力以单腿测试为准。
            </p>
          </div>
        )}
      </div>

      <div className="bg-bg-card border border-border-subtle rounded-2xl p-5">
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-text-primary">最新节段对标</h3>
          <p className="text-xs font-mono text-text-muted">Latest Scan vs Standard — {latest.scan_date}</p>
        </div>

        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={latestBars} margin={{ top: 5, right: 10, bottom: 0, left: 5 }}>
            <CartesianGrid {...GRID_STYLE} />
            <XAxis dataKey="seg" tick={AXIS_TICK} axisLine={{ stroke: '#d8dae5' }} tickLine={false} />
            <YAxis
              domain={[0, Math.max(120, Math.ceil(Math.max(...latestBars.map(b => b.pct ?? 0)) / 10) * 10 + 10)]}
              tick={AXIS_TICK}
              tickFormatter={formatTick}
              axisLine={false}
              tickLine={false}
              width={40}
            />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: unknown) => [`${v}%`, '% 标准']} />
            <ReferenceLine y={100} stroke="#00a85a" strokeDasharray="4 4" strokeOpacity={0.5} />
            <ReferenceLine y={85} stroke="#e68a00" strokeDasharray="4 4" strokeOpacity={0.4} />
            <Bar dataKey="pct" radius={[4, 4, 0, 0]} maxBarSize={40}>
              {latestBars.map((b, i) => (
                <Cell key={i} fill={pctStdColor(b.pct)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>

        <div className="overflow-x-auto mt-4">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b-2 border-border">
                <th className="text-left py-2 px-3 text-text-primary font-semibold">节段</th>
                <th className="text-right py-2 px-3 text-text-primary font-semibold">肌肉 kg</th>
                <th className="text-right py-2 px-3 text-text-primary font-semibold">脂肪 kg</th>
                <th className="text-right py-2 px-3 text-text-primary font-semibold">% 标准</th>
                <th className="text-left py-2 px-3 text-text-primary font-semibold">评级</th>
              </tr>
            </thead>
            <tbody>
              {latestBars.map((b, i) => (
                <tr key={b.key} className="border-b border-border-subtle animate-fade-in opacity-0" style={{ animationDelay: `${i * 30}ms`, animationFillMode: 'forwards' }}>
                  <td className="py-2 px-3">
                    <span className="inline-block w-2 h-2 rounded-full mr-2 align-middle" style={{ backgroundColor: b.color }} />
                    {b.seg}
                  </td>
                  <td className="py-2 px-3 text-right">{b.lean != null ? b.lean.toFixed(2) : '—'}</td>
                  <td className="py-2 px-3 text-right">{b.fat != null ? b.fat.toFixed(1) : '—'}</td>
                  <td className="py-2 px-3 text-right" style={{ color: pctStdColor(b.pct) }}>
                    {b.pct != null ? b.pct.toFixed(1) : '—'}
                  </td>
                  <td className="py-2 px-3">
                    {b.pct == null ? '—' :
                     b.pct >= 100 ? <span className="text-accent-green">达标</span> :
                     b.pct >= 85  ? <span className="text-accent-amber">偏弱</span> :
                                    <span className="text-accent-red">短板</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
