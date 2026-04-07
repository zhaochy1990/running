import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import type { TimeseriesPoint } from '../api'

function formatPace(sPerKm: number): string {
  if (!sPerKm || sPerKm <= 0 || sPerKm > 1200) return '—'
  const m = Math.floor(sPerKm / 60)
  const s = Math.floor(sPerKm % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function PaceChart({ data }: { data: TimeseriesPoint[] }) {
  const withTs = data.filter((p) => p.adjusted_pace && p.adjusted_pace > 0 && p.adjusted_pace < 1200 && p.timestamp != null)
  if (withTs.length === 0) {
    return <div className="text-text-muted text-sm text-center py-8">无配速数据</div>
  }

  const startTs = withTs[0].timestamp!
  const chartData = withTs.map((p) => ({
    elapsed: Math.round((p.timestamp! - startTs) / 100),
    pace: p.adjusted_pace,
  }))

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
        <defs>
          <linearGradient id="paceGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#00e676" stopOpacity={0.4} />
            <stop offset="100%" stopColor="#00e676" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="elapsed"
          tick={{ fontSize: 10, fill: '#555570', fontFamily: 'JetBrains Mono' }}
          axisLine={{ stroke: '#2a2a3e' }}
          tickLine={false}
          tickFormatter={(v) => formatTime(v)}
          interval={Math.floor(chartData.length / 6)}
        />
        <YAxis
          reversed
          domain={['dataMin - 10', 'dataMax + 10']}
          tick={{ fontSize: 10, fill: '#555570', fontFamily: 'JetBrains Mono' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v) => formatPace(v)}
        />
        <Tooltip
          contentStyle={{
            background: '#1e1e2e',
            border: '1px solid #2a2a3e',
            borderRadius: '8px',
            fontSize: '12px',
            fontFamily: 'JetBrains Mono',
            color: '#e8e8f0',
          }}
          formatter={(value) => [formatPace(value as number) + '/km', '配速']}
          labelFormatter={(label) => formatTime(label as number)}
        />
        <Area
          type="monotone"
          dataKey="pace"
          stroke="#00e676"
          strokeWidth={1.5}
          fill="url(#paceGradient)"
          dot={false}
          activeDot={{ r: 3, fill: '#00e676', stroke: '#1e1e2e', strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
