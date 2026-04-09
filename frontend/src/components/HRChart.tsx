import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import type { TimeseriesPoint } from '../api'

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function HRChart({ data }: { data: TimeseriesPoint[] }) {
  const withTs = data.filter((p) => p.heart_rate && p.heart_rate > 0 && p.timestamp != null)
  if (withTs.length === 0) {
    return <div className="text-text-muted text-sm text-center py-8">无心率数据</div>
  }

  const startTs = withTs[0].timestamp!
  const chartData = withTs.map((p) => ({
    elapsed: Math.round((p.timestamp! - startTs) / 100),
    hr: p.heart_rate,
  }))
  const avgHR = Math.round(withTs.reduce((sum, p) => sum + p.heart_rate!, 0) / withTs.length)

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
        <defs>
          <linearGradient id="hrGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff5252" stopOpacity={0.4} />
            <stop offset="100%" stopColor="#ff5252" stopOpacity={0.02} />
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
          domain={['dataMin - 10', 'dataMax + 5']}
          tick={{ fontSize: 10, fill: '#555570', fontFamily: 'JetBrains Mono' }}
          axisLine={false}
          tickLine={false}
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
          formatter={(value) => [`${value} bpm`, '心率']}
          labelFormatter={(label) => formatTime(label as number)}
        />
        <ReferenceLine y={avgHR} stroke="#ff5252" strokeDasharray="4 4" strokeOpacity={0.6} label={{ value: `avg ${avgHR}`, position: 'right', fill: '#ff5252', fontSize: 10, fontFamily: 'JetBrains Mono' }} />
        <Area
          type="monotone"
          dataKey="hr"
          stroke="#ff5252"
          strokeWidth={1.5}
          fill="url(#hrGradient)"
          dot={false}
          activeDot={{ r: 3, fill: '#ff5252', stroke: '#1e1e2e', strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
