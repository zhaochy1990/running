import type { Zone } from '../api'

const ZONE_COLORS = ['#00c853', '#64dd17', '#ffab00', '#ff6d00', '#ff1744', '#c2185b']
const ZONE_LABELS_HR = ['Z1 恢复', 'Z2 轻松', 'Z3 有氧', 'Z4 乳酸阈', 'Z5 最大摄氧', 'Z6 无氧']
const ZONE_LABELS_PACE = ['Z1 轻松', 'Z2 中等', 'Z3 节奏', 'Z4 乳酸阈', 'Z5 速度', 'Z6 冲刺']

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const rm = m % 60
    return `${h}h${rm}m`
  }
  return s > 0 ? `${m}m${s}s` : `${m}m`
}

function formatHRRange(zone: Zone, zones: Zone[]): string {
  if (zone.range_min == null || zone.range_max == null) return ''
  const min = Math.round(zone.range_min)
  const max = Math.round(zone.range_max)
  const maxIdx = Math.max(...zones.map((z) => z.zone_index))
  if (zone.zone_index === 1) {
    const z2 = zones.find((z) => z.zone_index === 2)
    if (z2?.range_min != null && Math.round(z2.range_min) === min) {
      return `< ${min}`
    }
  }
  if (zone.zone_index === maxIdx) return `≥ ${min}`
  return `${min}–${max}`
}

function formatPaceRange(zone: Zone, zones: Zone[]): string {
  if (zone.range_min == null || zone.range_max == null) return ''
  const toPace = (msPerKm: number) => {
    const s = Math.round(msPerKm / 1000)
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
  }
  const minPace = toPace(zone.range_min)
  const maxPace = toPace(zone.range_max)
  const maxIdx = Math.max(...zones.map((z) => z.zone_index))
  if (zone.zone_index === 1) {
    const z2 = zones.find((z) => z.zone_index === 2)
    if (z2?.range_min != null && Math.round(z2.range_min) === Math.round(zone.range_min)) {
      return `> ${maxPace}`
    }
  }
  if (zone.zone_index === maxIdx) return `< ${minPace}`
  return `${minPace}–${maxPace}`
}

export default function ZoneChart({ zones, type }: { zones: Zone[]; type: 'hr' | 'pace' }) {
  const labels = type === 'hr' ? ZONE_LABELS_HR : ZONE_LABELS_PACE
  const displayZones = zones.filter((z) => z.zone_index >= 1 && z.zone_index <= labels.length)
  const maxPercent = Math.max(...displayZones.map((z) => z.percent), 1)

  return (
    <div className="space-y-3">
      {displayZones.map((zone, i) => {
        const color = ZONE_COLORS[i] || '#555570'
        const width = Math.max((zone.percent / maxPercent) * 100, 2)

        const range = type === 'hr' ? formatHRRange(zone, displayZones) : formatPaceRange(zone, displayZones)
        const rangeUnit = type === 'hr' ? ' bpm' : '/km'

        return (
          <div key={zone.zone_index} className="group">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-mono text-text-muted">
                {labels[i] || `Z${zone.zone_index}`}
                {range && <span className="text-text-muted/70 ml-1.5">({range}{rangeUnit})</span>}
              </span>
              <div className="flex items-center gap-3">
                <span className="text-xs font-mono text-text-secondary">{formatDuration(zone.duration_s)}</span>
                <span className="text-xs font-mono font-medium min-w-[40px] text-right" style={{ color }}>
                  {zone.percent.toFixed(1)}%
                </span>
              </div>
            </div>
            <div className="h-5 bg-bg-secondary rounded-md overflow-hidden">
              <div
                className="h-full rounded-md transition-all duration-500 ease-out group-hover:brightness-125"
                style={{
                  width: `${width}%`,
                  backgroundColor: color,
                  opacity: 0.8,
                }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
