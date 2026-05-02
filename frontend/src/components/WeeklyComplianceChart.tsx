import {
  BarChart, Bar, Cell, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend,
} from 'recharts'

export interface WeeklyCompliancePoint {
  /** Anything human-readable: e.g. "W14" or "4/20–4/26". */
  label: string
  planned_km: number | null
  actual_km: number | null
  /** 0..1 share of run sessions with avg pace inside target band. */
  pace_compliance: number | null
}

export interface WeeklyComplianceChartProps {
  data: WeeklyCompliancePoint[]
}

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

function complianceColor(actualPct: number | null): string {
  if (actualPct == null) return '#8888a0'
  if (actualPct >= 0.9 && actualPct <= 1.1) return '#00a85a'
  if (actualPct >= 0.75 && actualPct <= 1.25) return '#e68a00'
  return '#d32f2f'
}

export default function WeeklyComplianceChart({ data }: WeeklyComplianceChartProps) {
  const enriched = data.map((d) => {
    const ratio = d.planned_km != null && d.planned_km > 0 && d.actual_km != null
      ? d.actual_km / d.planned_km
      : null
    return { ...d, ratio }
  })

  if (enriched.length === 0) {
    return (
      <div
        data-testid="compliance-empty"
        className="bg-bg-card border border-border-subtle rounded-2xl p-6 text-center text-sm text-text-muted"
      >
        近期暂无周度计划与实跑数据
      </div>
    )
  }

  return (
    <div data-testid="weekly-compliance-chart" className="bg-bg-card border border-border-subtle rounded-2xl p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-text-primary">周度依从性</h3>
        <p className="text-xs font-mono text-text-muted">
          Planned vs Actual mileage · pace target compliance
        </p>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={enriched} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
          <CartesianGrid {...GRID_STYLE} />
          <XAxis dataKey="label" tick={AXIS_TICK} axisLine={{ stroke: '#d8dae5' }} tickLine={false} />
          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} />
          <Tooltip {...TOOLTIP_STYLE} />
          <Legend wrapperStyle={{ fontFamily: 'JetBrains Mono', fontSize: 11 }} />
          <Bar dataKey="planned_km" name="计划 km" fill="#0097a7" fillOpacity={0.4} radius={[2, 2, 0, 0]} />
          <Bar dataKey="actual_km" name="实跑 km" radius={[2, 2, 0, 0]}>
            {enriched.map((entry, i) => (
              <Cell key={i} fill={complianceColor(entry.ratio)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
