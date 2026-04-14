import { useState } from 'react'
import type { Segment } from '../api'

function getHRColor(hr: number | null): string {
  if (!hr) return '#555570'
  if (hr < 100) return '#00e676'
  if (hr < 120) return '#ffab00'
  return '#ff5252'
}

function formatTime(s: number | null): string {
  if (!s) return '—'
  const mins = Math.floor(s / 60)
  const secs = Math.round(s % 60)
  return `${mins}:${String(secs).padStart(2, '0')}`
}

interface SetWithRest {
  set: Segment
  rest_s: number | null
}

interface ExerciseGroup {
  name: string
  sets: SetWithRest[]
}

function isRest(seg: Segment): boolean {
  return seg.seg_name === '休息' || seg.mode === 15 || seg.mode === 16 || seg.mode === 17
}

function groupByExercise(segments: Segment[]): ExerciseGroup[] {
  const groups: ExerciseGroup[] = []
  let current: ExerciseGroup | null = null

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (isRest(seg)) continue

    const name = seg.seg_name
    // Look ahead for a rest segment
    const next = i + 1 < segments.length ? segments[i + 1] : null
    const rest_s = next && isRest(next) ? next.duration_s : null

    const entry: SetWithRest = { set: seg, rest_s }
    if (current && current.name === name) {
      current.sets.push(entry)
    } else {
      current = { name, sets: [entry] }
      groups.push(current)
    }
  }
  return groups
}

export default function StrengthView({ segments }: { segments: Segment[] }) {
  const groups = groupByExercise(segments)

  if (groups.length === 0) return null

  return (
    <div className="space-y-3">
      {groups.map((group, i) => (
        <ExerciseRow key={i} index={i + 1} group={group} />
      ))}
    </div>
  )
}

function ExerciseRow({ index, group }: { index: number; group: ExerciseGroup }) {
  const [expanded, setExpanded] = useState(false)
  const totalTime = group.sets.reduce((sum, s) => sum + (s.set.duration_s || 0), 0)
  const setsWithHR = group.sets.filter(s => s.set.avg_hr)
  const avgHR = setsWithHR.length > 0
    ? Math.round(setsWithHR.reduce((sum, s) => sum + (s.set.avg_hr || 0), 0) / setsWithHR.length)
    : 0

  return (
    <div className="rounded-lg border border-border-subtle overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-card-hover cursor-pointer ${expanded ? 'bg-bg-card-hover' : 'bg-bg-card'}`}
      >
        <span
          className={`text-xl text-accent-green transition-transform duration-200 w-6 text-center leading-none ${expanded ? 'rotate-90' : ''}`}
        >
          &#9656;
        </span>
        <span className="text-xs font-mono text-text-muted w-5">{index}</span>
        <div className="w-1.5 h-5 rounded-full bg-[#ff6d00]" />
        <span className="text-sm font-medium text-[#ff6d00]">{group.name}</span>
        <span className="text-[9px] font-mono text-text-muted ml-1">{group.sets.length} 组</span>

        <div className="flex-1 flex items-center gap-6 ml-4">
          <div className="min-w-[60px]">
            <p className="text-[9px] font-mono text-text-muted">总时长</p>
            <p className="text-xs font-mono font-medium text-text-secondary mt-0.5">{formatTime(totalTime)}</p>
          </div>
          <div className="min-w-[60px]">
            <p className="text-[9px] font-mono text-text-muted">平均心率</p>
            <p className="text-xs font-mono font-medium mt-0.5" style={{ color: getHRColor(avgHR) }}>
              {avgHR || '—'}
            </p>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border-subtle bg-bg-secondary/50">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border-subtle">
                <th className="text-left py-1.5 px-4 font-mono text-text-muted font-normal">组</th>
                <th className="text-right py-1.5 px-3 font-mono text-text-muted font-normal">时长</th>
                <th className="text-right py-1.5 px-3 font-mono text-text-muted font-normal">休息</th>
                <th className="text-right py-1.5 px-3 font-mono text-text-muted font-normal">心率</th>
                <th className="text-right py-1.5 px-3 font-mono text-text-muted font-normal">最高心率</th>
              </tr>
            </thead>
            <tbody>
              {group.sets.map((entry, i) => (
                <tr key={i} className="border-b border-border-subtle/50 hover:bg-bg-card-hover/50 transition-colors">
                  <td className="py-1.5 px-4 font-mono text-text-muted">{i + 1}</td>
                  <td className="py-1.5 px-3 text-right font-mono text-text-secondary">{formatTime(entry.set.duration_s)}</td>
                  <td className="py-1.5 px-3 text-right font-mono text-text-muted">{formatTime(entry.rest_s)}</td>
                  <td className="py-1.5 px-3 text-right font-mono" style={{ color: getHRColor(entry.set.avg_hr) }}>
                    {entry.set.avg_hr || '—'}
                  </td>
                  <td className="py-1.5 px-3 text-right font-mono" style={{ color: getHRColor(entry.set.max_hr) }}>
                    {entry.set.max_hr || '—'}
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
