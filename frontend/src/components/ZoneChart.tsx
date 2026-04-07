import type { Zone } from '../api'

const ZONE_COLORS = ['#00c853', '#64dd17', '#ffab00', '#ff6d00', '#ff1744']
const ZONE_LABELS_HR = ['Z1 恢复', 'Z2 轻松', 'Z3 有氧', 'Z4 乳酸阈', 'Z5 最大摄氧']
const ZONE_LABELS_PACE = ['Z1 轻松', 'Z2 中等', 'Z3 节奏', 'Z4 乳酸阈', 'Z5 速度']

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

export default function ZoneChart({ zones, type }: { zones: Zone[]; type: 'hr' | 'pace' }) {
  const labels = type === 'hr' ? ZONE_LABELS_HR : ZONE_LABELS_PACE
  const maxPercent = Math.max(...zones.map((z) => z.percent), 1)

  return (
    <div className="space-y-3">
      {zones.map((zone, i) => {
        const color = ZONE_COLORS[i] || '#555570'
        const width = Math.max((zone.percent / maxPercent) * 100, 2)

        return (
          <div key={zone.zone_index} className="group">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-mono text-text-muted">{labels[i] || `Z${zone.zone_index}`}</span>
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
