import { useState } from 'react'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts'
import type { AbilityHistoryPoint } from '../api'
import { fmtHMS, fmtScore } from '../lib/fmt'

type Dim = 'aerobic' | 'lt' | 'vo2max' | 'endurance' | 'economy' | 'recovery'

const DIM_META: Record<Dim, { label: string; color: string }> = {
  aerobic: { label: '有氧', color: '#00a85a' },
  lt: { label: '乳酸阈', color: '#ffab00' },
  vo2max: { label: '最大摄氧', color: '#d32f2f' },
  endurance: { label: '耐力', color: '#0097a7' },
  economy: { label: '经济性', color: '#7e57c2' },
  recovery: { label: '恢复', color: '#8888a0' },
}

function formatDateShort(dateStr: string): string {
  if (!dateStr) return dateStr
  // YYYY-MM-DD or YYYYMMDD → M/D
  const normalized = dateStr.replace(/-/g, '')
  if (normalized.length >= 8) {
    const m = parseInt(normalized.slice(4, 6), 10)
    const d = parseInt(normalized.slice(6, 8), 10)
    return `${m}/${d}`
  }
  return dateStr
}

export default function AbilityHistoryChart({
  history, days, onDaysChange,
}: {
  history: AbilityHistoryPoint[]
  days: number
  onDaysChange: (d: number) => void
}) {
  const [enabled, setEnabled] = useState<Set<Dim>>(new Set())

  const data = history.map((h) => ({
    dateLabel: formatDateShort(h.date),
    date: h.date,
    composite: h.l4_composite,
    marathon_s: h.l4_marathon_race_s,
    aerobic: h.l3.aerobic,
    lt: h.l3.lt,
    vo2max: h.l3.vo2max,
    endurance: h.l3.endurance,
    economy: h.l3.economy,
    recovery: h.l3.recovery,
  }))

  const toggle = (k: Dim) => {
    setEnabled((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">能力趋势</h3>
          <p className="text-xs font-mono text-text-muted">
            Ability History · L4 composite {enabled.size > 0 && `+ ${enabled.size} L3`}
          </p>
        </div>
        <div className="flex gap-1 p-1 bg-bg-secondary rounded-lg">
          {[30, 60, 90, 180].map((d) => (
            <button
              key={d}
              onClick={() => onDaysChange(d)}
              className={`px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-all ${
                days === d
                  ? 'bg-accent-green/15 text-accent-green'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {d}天
            </button>
          ))}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
          <CartesianGrid stroke="#e8eaf0" strokeDasharray="3 3" />
          <XAxis
            dataKey="dateLabel"
            tick={{ fontSize: 10, fontFamily: 'JetBrains Mono', fill: '#8888a0' }}
            axisLine={{ stroke: '#d8dae5' }}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 10, fontFamily: 'JetBrains Mono', fill: '#8888a0' }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              background: '#ffffff', border: '1px solid #d8dae5', borderRadius: 8,
              fontFamily: 'JetBrains Mono', fontSize: 12, color: '#1a1c2e',
            }}
            formatter={(v, name) => {
              const n = String(name ?? '')
              if (n === 'marathon_s') return [fmtHMS(Number(v)), '马拉松估算']
              return [fmtScore(Number(v), 1), n]
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, fontFamily: 'JetBrains Mono', paddingTop: 4 }}
          />
          <Line
            type="monotone"
            dataKey="composite"
            name="综合 (L4)"
            stroke="#1a1c2e"
            strokeWidth={2.5}
            dot={false}
            activeDot={{ r: 4, fill: '#1a1c2e', stroke: '#fff', strokeWidth: 2 }}
            connectNulls
          />
          {Array.from(enabled).map((k) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              name={DIM_META[k].label}
              stroke={DIM_META[k].color}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>

      <div className="flex flex-wrap gap-2 mt-4">
        {(Object.keys(DIM_META) as Dim[]).map((k) => {
          const on = enabled.has(k)
          return (
            <button
              key={k}
              onClick={() => toggle(k)}
              className={`text-xs font-mono px-2.5 py-1 rounded border transition-all ${
                on ? '' : 'opacity-50 hover:opacity-100'
              }`}
              style={{
                color: DIM_META[k].color,
                borderColor: on ? DIM_META[k].color : '#d8dae5',
                backgroundColor: on ? DIM_META[k].color + '15' : 'transparent',
              }}
            >
              <span className="inline-block w-2 h-2 rounded-sm mr-1.5 align-middle"
                style={{ backgroundColor: DIM_META[k].color }} />
              {DIM_META[k].label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
