import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer, ReferenceLine, Label } from 'recharts'
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

function findNearest<T extends { elapsed: number }>(data: T[], target: number): T | undefined {
  if (!data.length) return undefined
  let lo = 0, hi = data.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (data[mid].elapsed < target) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(data[lo - 1].elapsed - target) < Math.abs(data[lo].elapsed - target)) return data[lo - 1]
  return data[lo]
}

function HoverLabel({ viewBox, text, color }: { viewBox?: { x?: number; y?: number; width?: number }; text: string; color: string }) {
  if (!viewBox) return null
  const lineX = viewBox.x ?? 0
  const chartTop = viewBox.y ?? 0
  const chartWidth = viewBox.width ?? 0
  const boxHeight = 20
  const charWidth = 6.5
  const padding = 8
  const boxWidth = text.length * charWidth + padding * 2
  let boxX = lineX - boxWidth / 2
  const rightEdge = chartWidth
  if (boxX < -40) boxX = lineX + 4
  if (boxX + boxWidth > rightEdge + 40) boxX = lineX - boxWidth - 4
  const boxY = chartTop + 6
  return (
    <g pointerEvents="none">
      <rect
        x={boxX}
        y={boxY}
        width={boxWidth}
        height={boxHeight}
        fill="#ffffff"
        stroke="#d8dae5"
        strokeWidth={1}
        rx={4}
      />
      <text
        x={boxX + boxWidth / 2}
        y={boxY + 14}
        fontSize={11}
        fontFamily="JetBrains Mono"
        fill={color}
        textAnchor="middle"
      >
        {text}
      </text>
    </g>
  )
}

type Props = {
  data: TimeseriesPoint[]
  startTs?: number
  hoverElapsed?: number | null
  onHover?: (elapsed: number | null) => void
}

export default function PaceChart({ data, startTs: startTsProp, hoverElapsed, onHover }: Props) {
  const withTs = data.filter((p) => {
    const pace = p.adjusted_pace ?? p.speed
    return pace && pace > 0 && pace < 1200 && p.timestamp != null
  })
  if (withTs.length === 0) {
    return <div className="text-text-muted text-sm text-center py-8">无配速数据</div>
  }

  const startTs = startTsProp ?? withTs[0].timestamp!
  const chartData = withTs.map((p) => ({
    elapsed: Math.round((p.timestamp! - startTs) / 100),
    pace: p.adjusted_pace ?? p.speed,
  }))
  const avgPace = Math.round(withTs.reduce((sum, p) => sum + (p.adjusted_pace ?? p.speed)!, 0) / withTs.length)

  const hoverPoint = hoverElapsed != null ? findNearest(chartData, hoverElapsed) : undefined
  const hoverText = hoverElapsed != null
    ? `${formatTime(hoverElapsed)}  ${hoverPoint?.pace ? formatPace(hoverPoint.pace) + '/km' : '—'}`
    : ''

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart
        data={chartData}
        margin={{ top: 30, right: 5, bottom: 0, left: -5 }}
        onMouseMove={(state) => {
          if (state?.activeLabel != null) onHover?.(Number(state.activeLabel))
        }}
        onMouseLeave={() => onHover?.(null)}
      >
        <XAxis
          dataKey="elapsed"
          tick={{ fontSize: 10, fill: '#8888a0', fontFamily: 'JetBrains Mono' }}
          axisLine={{ stroke: '#d8dae5' }}
          tickLine={false}
          tickFormatter={(v) => formatTime(v)}
          interval={Math.floor(chartData.length / 6)}
        />
        <YAxis
          reversed
          domain={['dataMin - 10', 'dataMax + 10']}
          tick={{ fontSize: 10, fill: '#8888a0', fontFamily: 'JetBrains Mono' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v) => formatPace(v)}
        />
        <ReferenceLine y={avgPace} stroke="#00a85a" strokeDasharray="4 4" strokeOpacity={0.6} label={{ value: `avg ${formatPace(avgPace)}`, position: 'right', fill: '#00a85a', fontSize: 10, fontFamily: 'JetBrains Mono' }} />
        {hoverElapsed != null && (
          <ReferenceLine x={hoverElapsed} stroke="#1a1c2e" strokeOpacity={0.35} strokeWidth={1} ifOverflow="extendDomain">
            <Label content={(props: any) => <HoverLabel {...props} text={hoverText} color="#00a85a" />} />
          </ReferenceLine>
        )}
        <Area
          type="monotone"
          dataKey="pace"
          stroke="#00a85a"
          strokeWidth={1.5}
          fill="none"
          dot={false}
          activeDot={{ r: 3, fill: '#00a85a', stroke: '#ffffff', strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
