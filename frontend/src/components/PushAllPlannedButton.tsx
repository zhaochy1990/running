import { useMemo, useState } from 'react'
import type { PlannedSession, StructuredStatus } from '../types/plan'
import { isPushable, isPushableStatus } from '../types/plan'
import { computeWeekPlanIntensity } from '../lib/planIntensity'

export interface PushAllPlannedButtonProps {
  sessions: PlannedSession[]
  structuredStatus: StructuredStatus
  canPushRun: boolean
  /** Defaults to `canPushRun` to mirror `PushPlannedButton`. */
  canPushStrength?: boolean
  onPush: (session: PlannedSession) => Promise<void> | void
  /** Lets the parent disable individual push buttons during a batch run. */
  onBatchStateChange?: (busy: boolean) => void
}

interface PushResult {
  session: PlannedSession
  ok: boolean
  error?: string
}

/** Sessions the batch button should attempt to push:
 *   - kind ∈ {run, strength} with a complete spec
 *   - capability gate satisfied for the kind
 *   - not already pushed (re-pushing is reserved for the per-row button so
 *     users explicitly opt into replacing a watch entry).
 */
export function pushableSessionsFor(
  sessions: PlannedSession[],
  canPushRun: boolean,
  canPushStrength: boolean,
): PlannedSession[] {
  return sessions.filter((s) => {
    if (!isPushable(s)) return false
    if (s.kind === 'run' && !canPushRun) return false
    if (s.kind === 'strength' && !canPushStrength) return false
    if (s.scheduled_workout_id != null) return false
    return true
  })
}

/** Single-row action bar combining:
 *   - Planned weekly mileage breakdown (总跑量 / 低强度 Z1+Z2 / 高强度 Z4+Z5)
 *   - "一键推送" batch action for pushable run/strength sessions
 *
 * Both halves are bound to the same week, so colocating them avoids a
 * second card on the calendar tab.
 */
export default function PushAllPlannedButton({
  sessions,
  structuredStatus,
  canPushRun,
  canPushStrength,
  onPush,
  onBatchStateChange,
}: PushAllPlannedButtonProps) {
  const [pushing, setPushing] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [results, setResults] = useState<PushResult[] | null>(null)

  const strengthCap = canPushStrength ?? canPushRun
  const targets = useMemo(
    () => pushableSessionsFor(sessions, canPushRun, strengthCap),
    [sessions, canPushRun, strengthCap],
  )
  const total = targets.length
  const planned = useMemo(() => computeWeekPlanIntensity(sessions), [sessions])

  if (!isPushableStatus(structuredStatus)) return null

  // Eligible = run/strength sessions with a spec, regardless of push state.
  // Drives whether the batch button appears at all.
  const eligibleTotal = sessions.filter((s) => {
    if (!isPushable(s)) return false
    if (s.kind === 'run' && !canPushRun) return false
    if (s.kind === 'strength' && !strengthCap) return false
    return true
  }).length

  // Hide entirely when there's no run mileage AND no eligible push targets —
  // an all-rest week has nothing for either half to display.
  if (planned.total_km <= 0 && eligibleTotal === 0) return null

  const disabled = pushing || total === 0

  const label = pushing
    ? `推送中… (${progress?.done ?? 0}/${progress?.total ?? total})`
    : total === 0
      ? '✓ 全部已推送'
      : `一键推送 (${total})`

  const ariaLabel = pushing
    ? '推送中'
    : total === 0
      ? '全部已推送'
      : '一键推送本周训练'

  const handle = async () => {
    if (disabled) return
    setPushing(true)
    setResults(null)
    setProgress({ done: 0, total })
    onBatchStateChange?.(true)
    const out: PushResult[] = []
    try {
      for (let i = 0; i < targets.length; i++) {
        const s = targets[i]
        try {
          await onPush(s)
          out.push({ session: s, ok: true })
        } catch (e) {
          out.push({
            session: s,
            ok: false,
            error: e instanceof Error ? e.message : '推送失败',
          })
        }
        setProgress({ done: i + 1, total })
      }
    } finally {
      setResults(out)
      setPushing(false)
      onBatchStateChange?.(false)
    }
  }

  const okCount = results?.filter((r) => r.ok).length ?? 0
  const failCount = results?.filter((r) => !r.ok).length ?? 0

  return (
    <div data-testid="push-all-container" className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-accent-green/30 bg-accent-green/10 px-4 py-2.5">
        <div
          data-testid="plan-intensity-stats"
          className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs font-mono"
        >
          <Stat label="计划跑量" value={planned.total_km} />
          <Stat label="低强度 Z1+Z2" value={planned.low_km} />
          <Stat label="高强度 Z4+Z5" value={planned.high_km} />
        </div>
        {eligibleTotal > 0 && (
          <button
            type="button"
            onClick={handle}
            disabled={disabled}
            aria-label={ariaLabel}
            data-testid="push-all-button"
            className={
              'px-3 py-1.5 text-xs font-medium rounded-lg border transition-all whitespace-nowrap ' +
              (disabled
                ? 'border-border-subtle text-text-muted cursor-not-allowed opacity-60'
                : 'border-accent-green/40 text-accent-green hover:bg-accent-green/15 cursor-pointer')
            }
          >
            {label}
          </button>
        )}
      </div>
      {results && results.length > 0 && (
        <div
          data-testid="push-all-results"
          role="status"
          className="px-4 py-1 text-[11px] font-mono"
        >
          <span className="text-accent-green">成功 {okCount}</span>
          {failCount > 0 && (
            <>
              <span className="ml-3 text-accent-red">失败 {failCount}</span>
              <ul className="mt-1 list-inside list-disc text-accent-red">
                {results
                  .filter((r) => !r.ok)
                  .map((r) => (
                    <li key={`${r.session.date}-${r.session.session_index}`}>
                      {r.session.date} {r.session.summary}: {r.error}
                    </li>
                  ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-text-muted">{label}</span>
      <span className="ml-1.5 font-semibold text-accent-green">
        {value.toFixed(1)} km
      </span>
    </span>
  )
}
