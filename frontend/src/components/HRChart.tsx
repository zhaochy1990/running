import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer, ReferenceLine, Label } from 'recharts'
import type { LabelProps } from 'recharts'
import type { TimeseriesPoint } from '../api'

interface CartesianLabelViewBox {
  x?: number
  y?: number
  width?: number
}

function readCartesianViewBox(viewBox: unknown): CartesianLabelViewBox | null {
  if (!viewBox || typeof viewBox !== 'object') return null
  const data = viewBox as Record<string, unknown>
  return {
    x: typeof data.x === 'number' ? data.x : undefined,
    y: typeof data.y === 'number' ? data.y : undefined,
    width: typeof data.width === 'number' ? data.width : undefined,
  }
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

function HoverLabel({ viewBox, text, color }: { viewBox: unknown; text: string; color: string }) {
  const cartesianViewBox = readCartesianViewBox(viewBox)
  if (!cartesianViewBox) return null
  const lineX = cartesianViewBox.x ?? 0
  const chartTop = cartesianViewBox.y ?? 0
  const chartWidth = cartesianViewBox.width ?? 0
  const boxHeight = 20
  const charWidth = 6.5
  const padding = 8
  const boxWidth = text.length * charWidth + padding * 2
  let boxX = lineX - boxWidth / 2
  if (boxX < -40) boxX = lineX + 4
  if (boxX + boxWidth > chartWidth + 40) boxX = lineX - boxWidth - 4
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

export default function HRChart({ data, startTs: startTsProp, hoverElapsed, onHover }: Props) {
  const withTs = data.filter((p) => p.heart_rate && p.heart_rate > 0 && p.timestamp != null)
  if (withTs.length === 0) {
    return <div className="text-text-muted text-sm text-center py-8">无心率数据</div>
  }

  const startTs = startTsProp ?? withTs[0].timestamp!
  const chartData = withTs.map((p) => ({
    elapsed: Math.round((p.timestamp! - startTs) / 100),
    hr: p.heart_rate,
  }))
  const avgHR = Math.round(withTs.reduce((sum, p) => sum + p.heart_rate!, 0) / withTs.length)

  const hoverPoint = hoverElapsed != null ? findNearest(chartData, hoverElapsed) : undefined
  const hoverText = hoverElapsed != null
    ? `${formatTime(hoverElapsed)}  ${hoverPoint?.hr ?? '—'} bpm`
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
        <ReferenceLine y={avgHR} stroke="#d32f2f" strokeDasharray="4 4" strokeOpacity={0.6} label={{ value: `avg ${avgHR}`, position: 'right', fill: '#d32f2f', fontSize: 10, fontFamily: 'JetBrains Mono' }} />
        {hoverElapsed != null && (
          <ReferenceLine x={hoverElapsed} stroke="#1a1c2e" strokeOpacity={0.35} strokeWidth={1} ifOverflow="extendDomain">
            <Label content={(props: LabelProps) => <HoverLabel viewBox={props.viewBox} text={hoverText} color="#d32f2f" />} />
          </ReferenceLine>
        )}
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
