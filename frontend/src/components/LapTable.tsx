import type { Lap } from '../api'

const ZONE_COLORS = ['#00c853', '#64dd17', '#ffab00', '#ff6d00', '#ff1744']

function getPaceColor(pace: number | null): string {
  if (!pace) return '#555570'
  if (pace > 360) return ZONE_COLORS[0]  // >6:00 easy
  if (pace > 300) return ZONE_COLORS[1]  // >5:00 moderate
  if (pace > 260) return ZONE_COLORS[2]  // >4:20 tempo
  if (pace > 230) return ZONE_COLORS[3]  // >3:50 threshold
  return ZONE_COLORS[4]                   // <3:50 fast
}

function getHRColor(hr: number | null): string {
  if (!hr) return '#555570'
  if (hr < 130) return ZONE_COLORS[0]
  if (hr < 145) return ZONE_COLORS[1]
  if (hr < 160) return ZONE_COLORS[2]
  if (hr < 175) return ZONE_COLORS[3]
  return ZONE_COLORS[4]
}

export default function LapTable({ laps }: { laps: Lap[] }) {
  // Find fastest lap for highlight
  const fastestPace = Math.min(...laps.filter(l => l.avg_pace).map(l => l.avg_pace!))

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b-2 border-border">
            <th className="text-left py-2 px-3 text-[10px] font-mono text-text-muted tracking-wider">段</th>
            <th className="text-right py-2 px-3 text-[10px] font-mono text-text-muted tracking-wider">距离</th>
            <th className="text-right py-2 px-3 text-[10px] font-mono text-text-muted tracking-wider">时长</th>
            <th className="text-right py-2 px-3 text-[10px] font-mono text-text-muted tracking-wider">配速</th>
            <th className="text-right py-2 px-3 text-[10px] font-mono text-text-muted tracking-wider">平均心率</th>
            <th className="text-right py-2 px-3 text-[10px] font-mono text-text-muted tracking-wider">最大心率</th>
            <th className="text-right py-2 px-3 text-[10px] font-mono text-text-muted tracking-wider">步频</th>
          </tr>
        </thead>
        <tbody>
          {laps.map((lap) => {
            const isFastest = lap.avg_pace === fastestPace
            return (
              <tr
                key={lap.lap_index}
                className={`border-b border-border-subtle hover:bg-bg-card-hover transition-colors ${
                  isFastest ? 'bg-accent-green/5' : ''
                }`}
              >
                <td className="py-2.5 px-3 font-mono text-text-muted text-xs">
                  {lap.lap_index}
                  {isFastest && <span className="ml-1.5 text-accent-green text-[9px]">最快</span>}
                </td>
                <td className="py-2.5 px-3 text-right font-mono text-text-secondary">{lap.distance_km} km</td>
                <td className="py-2.5 px-3 text-right font-mono text-text-secondary">{lap.duration_fmt}</td>
                <td className="py-2.5 px-3 text-right font-mono font-medium" style={{ color: getPaceColor(lap.avg_pace) }}>
                  {lap.pace_fmt}
                </td>
                <td className="py-2.5 px-3 text-right font-mono" style={{ color: getHRColor(lap.avg_hr) }}>
                  {lap.avg_hr || '—'}
                </td>
                <td className="py-2.5 px-3 text-right font-mono text-text-muted">
                  {lap.max_hr || '—'}
                </td>
                <td className="py-2.5 px-3 text-right font-mono text-text-muted">
                  {lap.avg_cadence || '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
