import { useState } from 'react'
import type { Lap, Segment } from '../api'

const ZONE_COLORS = ['#00c853', '#64dd17', '#ffab00', '#ff6d00', '#ff1744']

function getPaceColor(pace: number | null): string {
  if (!pace) return '#555570'
  if (pace > 360) return ZONE_COLORS[0]
  if (pace > 300) return ZONE_COLORS[1]
  if (pace > 260) return ZONE_COLORS[2]
  if (pace > 230) return ZONE_COLORS[3]
  return ZONE_COLORS[4]
}

function getHRColor(hr: number | null): string {
  if (!hr) return '#555570'
  if (hr < 130) return ZONE_COLORS[0]
  if (hr < 145) return ZONE_COLORS[1]
  if (hr < 160) return ZONE_COLORS[2]
  if (hr < 175) return ZONE_COLORS[3]
  return ZONE_COLORS[4]
}

const SEG_NAME_COLORS: Record<string, string> = {
  '热身': '#00e5ff',
  '慢跑': '#00e676',
  '大步跑': '#ff6d00',
  '恢复': '#64dd17',
  '放松': '#b388ff',
  '快跑': '#ff1744',
  '训练': '#ffab00',
}

function segColor(name: string): string {
  return SEG_NAME_COLORS[name] || '#8888a0'
}

/** Assign autoKm laps to their parent segment based on cumulative distance */
function groupLapsIntoSegments(segments: Segment[], laps: Lap[]): Map<number, Lap[]> {
  const result = new Map<number, Lap[]>()
  if (segments.length === 0 || laps.length === 0) return result

  // Build cumulative distance boundaries for segments
  const boundaries: { segIdx: number; start: number; end: number }[] = []
  let cumDist = 0
  for (let i = 0; i < segments.length; i++) {
    const segDist = segments[i].distance_km || 0
    boundaries.push({ segIdx: i, start: cumDist, end: cumDist + segDist })
    cumDist += segDist
    result.set(i, [])
  }

  // Assign each autoKm lap to a segment based on its cumulative midpoint
  let lapCumDist = 0
  for (const lap of laps) {
    const lapDist = lap.distance_km || 0
    const lapMid = lapCumDist + lapDist / 2
    lapCumDist += lapDist

    // Find which segment this lap's midpoint falls into
    let assigned = false
    for (const b of boundaries) {
      if (lapMid >= b.start && lapMid < b.end + 0.01) {
        result.get(b.segIdx)!.push(lap)
        assigned = true
        break
      }
    }
    if (!assigned && boundaries.length > 0) {
      // Assign to last segment
      result.get(boundaries[boundaries.length - 1].segIdx)!.push(lap)
    }
  }

  return result
}

export default function SegmentView({ segments, laps }: { segments: Segment[]; laps: Lap[] }) {
  const groupedLaps = groupLapsIntoSegments(segments, laps)

  if (segments.length === 0) {
    // Fallback: no segments, just show flat laps
    return <FlatLapTable laps={laps} />
  }

  return (
    <div className="space-y-2">
      {segments.map((seg, i) => (
        <SegmentRow
          key={i}
          index={i + 1}
          segment={seg}
          childLaps={groupedLaps.get(i) || []}
        />
      ))}
    </div>
  )
}

function SegmentRow({ index, segment, childLaps }: { index: number; segment: Segment; childLaps: Lap[] }) {
  const [expanded, setExpanded] = useState(false)
  const color = segColor(segment.seg_name)
  const hasChildren = childLaps.length > 1
  const isRecovery = segment.seg_name === '恢复'

  return (
    <div className={`rounded-lg overflow-hidden ${isRecovery ? 'border border-border-subtle/30' : 'border border-border-subtle'}`}>
      {/* Segment header */}
      <button
        onClick={() => hasChildren && setExpanded(!expanded)}
        className={`w-full flex items-center gap-3 px-4 text-left transition-colors ${
          isRecovery ? 'py-1 opacity-35' : 'py-3'
        } ${
          hasChildren ? 'hover:bg-bg-card-hover cursor-pointer' : 'cursor-default'
        } ${expanded ? 'bg-bg-card-hover' : 'bg-bg-card'}`}
      >
        {/* Expand chevron + Index + name */}
        <div className="flex items-center gap-2 min-w-[140px]">
          {hasChildren ? (
            <span
              className={`text-xl text-accent-green transition-transform duration-200 w-6 text-center leading-none ${expanded ? 'rotate-90' : ''}`}
            >
              &#9656;
            </span>
          ) : (
            <span className="w-6" />
          )}
          <span className="text-xs font-mono text-text-muted w-5">{index}</span>
          <div
            className="w-1.5 h-5 rounded-full"
            style={{ backgroundColor: color }}
          />
          <span className="text-sm font-medium" style={{ color }}>
            {segment.seg_name}
          </span>
          {hasChildren && (
            <span className="text-[9px] font-mono text-text-muted ml-1">
              {childLaps.length} 圈
            </span>
          )}
        </div>

        {/* Metrics */}
        <div className="flex-1 flex items-center gap-6">
          <SegMetric label="距离" value={`${segment.distance_km} km`} />
          <SegMetric label="时长" value={segment.duration_fmt} />
          <SegMetric label="配速" value={segment.pace_fmt} color={getPaceColor(segment.avg_pace)} />
          <SegMetric label="心率" value={segment.avg_hr ? `${segment.avg_hr}` : '—'} color={getHRColor(segment.avg_hr)} />
        </div>

        {/* Spacer for alignment */}
        <span className="w-4" />
      </button>

      {/* Expanded child laps */}
      {expanded && hasChildren && (
        <div className="border-t border-border-subtle bg-bg-secondary/50">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border-subtle">
                <th className="text-left py-1.5 px-4 font-mono text-text-muted font-normal">圈</th>
                <th className="text-right py-1.5 px-3 font-mono text-text-muted font-normal">距离</th>
                <th className="text-right py-1.5 px-3 font-mono text-text-muted font-normal">时长</th>
                <th className="text-right py-1.5 px-3 font-mono text-text-muted font-normal">配速</th>
                <th className="text-right py-1.5 px-3 font-mono text-text-muted font-normal">心率</th>
                <th className="text-right py-1.5 px-3 font-mono text-text-muted font-normal">步频</th>
              </tr>
            </thead>
            <tbody>
              {childLaps.map((lap, i) => (
                <tr key={lap.lap_index} className="border-b border-border-subtle/50 hover:bg-bg-card-hover/50 transition-colors">
                  <td className="py-1.5 px-4 font-mono text-text-muted">{i + 1}</td>
                  <td className="py-1.5 px-3 text-right font-mono text-text-secondary">{lap.distance_km} km</td>
                  <td className="py-1.5 px-3 text-right font-mono text-text-secondary">{lap.duration_fmt}</td>
                  <td className="py-1.5 px-3 text-right font-mono font-medium" style={{ color: getPaceColor(lap.avg_pace) }}>
                    {lap.pace_fmt}
                  </td>
                  <td className="py-1.5 px-3 text-right font-mono" style={{ color: getHRColor(lap.avg_hr) }}>
                    {lap.avg_hr || '—'}
                  </td>
                  <td className="py-1.5 px-3 text-right font-mono text-text-muted">
                    {lap.avg_cadence || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function SegMetric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="min-w-[60px]">
      <p className="text-[9px] font-mono text-text-muted">{label}</p>
      <p className="text-xs font-mono font-medium mt-0.5" style={color ? { color } : undefined}>
        {value}
      </p>
    </div>
  )
}

function FlatLapTable({ laps }: { laps: Lap[] }) {
  const fastestPace = Math.min(...laps.filter(l => l.avg_pace).map(l => l.avg_pace!))
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b-2 border-border">
          <th className="text-left py-2 px-3 text-[10px] font-mono text-text-muted">段</th>
          <th className="text-right py-2 px-3 text-[10px] font-mono text-text-muted">距离</th>
          <th className="text-right py-2 px-3 text-[10px] font-mono text-text-muted">时长</th>
          <th className="text-right py-2 px-3 text-[10px] font-mono text-text-muted">配速</th>
          <th className="text-right py-2 px-3 text-[10px] font-mono text-text-muted">心率</th>
          <th className="text-right py-2 px-3 text-[10px] font-mono text-text-muted">步频</th>
        </tr>
      </thead>
      <tbody>
        {laps.map((lap) => (
          <tr key={lap.lap_index} className={`border-b border-border-subtle hover:bg-bg-card-hover transition-colors ${lap.avg_pace === fastestPace ? 'bg-accent-green/5' : ''}`}>
            <td className="py-2 px-3 font-mono text-text-muted text-xs">
              {lap.lap_index}
              {lap.avg_pace === fastestPace && <span className="ml-1.5 text-accent-green text-[9px]">最快</span>}
            </td>
            <td className="py-2 px-3 text-right font-mono text-text-secondary">{lap.distance_km} km</td>
            <td className="py-2 px-3 text-right font-mono text-text-secondary">{lap.duration_fmt}</td>
            <td className="py-2 px-3 text-right font-mono font-medium" style={{ color: getPaceColor(lap.avg_pace) }}>{lap.pace_fmt}</td>
            <td className="py-2 px-3 text-right font-mono" style={{ color: getHRColor(lap.avg_hr) }}>{lap.avg_hr || '—'}</td>
            <td className="py-2 px-3 text-right font-mono text-text-muted">{lap.avg_cadence || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
