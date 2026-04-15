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
            <stop offset="0%" stopColor="#d32f2f" stopOpacity={0.4} />
            <stop offset="100%" stopColor="#d32f2f" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="elapsed"
          tick={{ fontSize: 10, fill: '#8888a0', fontFamily: 'JetBrains Mono' }}
          axisLine={{ stroke: '#d8dae5' }}
          tickLine={false}
          tickFormatter={(v) => formatTime(v)}
          interval={Math.floor(chartData.length / 6)}
        />
        <YAxis
          domain={['dataMin - 10', 'dataMax + 5']}
          tick={{ fontSize: 10, fill: '#8888a0', fontFamily: 'JetBrains Mono' }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          contentStyle={{
            background: '#ffffff',
            border: '1px solid #d8dae5',
            borderRadius: '8px',
            fontSize: '12px',
            fontFamily: 'JetBrains Mono',
            color: '#1a1c2e',
          }}
          formatter={(value) => [`${value} bpm`, '心率']}
          labelFormatter={(label) => formatTime(label as number)}
        />
        <ReferenceLine y={avgHR} stroke="#d32f2f" strokeDasharray="4 4" strokeOpacity={0.6} label={{ value: `avg ${avgHR}`, position: 'right', fill: '#d32f2f', fontSize: 10, fontFamily: 'JetBrains Mono' }} />
        <Area
          type="monotone"
          dataKey="hr"
          stroke="#d32f2f"
          strokeWidth={1.5}
          fill="url(#hrGradient)"
          dot={false}
          activeDot={{ r: 3, fill: '#d32f2f', stroke: '#ffffff', strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
