import { useMemo, useState } from 'react'
import type { PlannedSession, StructuredStatus } from '../types/plan'
import { isPushable, isPushableStatus } from '../types/plan'

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

  if (!isPushableStatus(structuredStatus)) return null

  // Hide entirely when the week has no run/strength sessions in scope at all
  // (e.g. all-rest week, or capability-gated provider). The "all pushed"
  // message is only meaningful once at least one pushable session existed.
  const eligibleTotal = sessions.filter((s) => {
    if (!isPushable(s)) return false
    if (s.kind === 'run' && !canPushRun) return false
    if (s.kind === 'strength' && !strengthCap) return false
    return true
  }).length
  if (eligibleTotal === 0) return null

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
      <div className="flex items-center justify-between gap-3 rounded-xl border border-accent-green/30 bg-accent-green/10 px-4 py-2.5">
        <p className="text-xs font-mono text-accent-green">
          {total === 0
            ? '本周可推送训练已全部送至手表'
            : `本周还有 ${total} 个跑步/力量训练待推送`}
        </p>
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
