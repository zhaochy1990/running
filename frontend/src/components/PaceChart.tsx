import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
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
  const withTs = data.filter((p) => {
    const pace = p.adjusted_pace ?? p.speed
    return pace && pace > 0 && pace < 1200 && p.timestamp != null
  })
  if (withTs.length === 0) {
    return <div className="text-text-muted text-sm text-center py-8">无配速数据</div>
  }

  const startTs = withTs[0].timestamp!
  const chartData = withTs.map((p) => ({
    elapsed: Math.round((p.timestamp! - startTs) / 100),
    pace: p.adjusted_pace ?? p.speed,
  }))
  const avgPace = Math.round(withTs.reduce((sum, p) => sum + (p.adjusted_pace ?? p.speed)!, 0) / withTs.length)

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
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
        <ReferenceLine y={avgPace} stroke="#00e676" strokeDasharray="4 4" strokeOpacity={0.6} label={{ value: `avg ${formatPace(avgPace)}`, position: 'right', fill: '#00e676', fontSize: 10, fontFamily: 'JetBrains Mono' }} />
        <Area
          type="monotone"
          dataKey="pace"
          stroke="#00e676"
          strokeWidth={1.5}
          fill="none"
          dot={false}
          activeDot={{ r: 3, fill: '#00e676', stroke: '#1e1e2e', strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
