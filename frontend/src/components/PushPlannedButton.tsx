import { useState } from 'react'
import type { PlannedSession, StructuredStatus } from '../types/plan'
import { isPushable, isPushableStatus } from '../types/plan'

export interface PushPlannedButtonProps {
  session: PlannedSession
  /** Whole-week structured status; only `'fresh' | 'authored'` allows pushing. */
  structuredStatus: StructuredStatus
  /**
   * Whether the connected provider supports `PUSH_RUN_WORKOUT`. When false
   * (or unknown), the button is hidden entirely instead of disabled, matching
   * the existing pattern for capability-gated controls.
   */
  canPushRun: boolean
  /**
   * Optional override to force-disable (e.g. while a parent operation is
   * already in flight). The component also disables itself while the push
   * promise is unresolved.
   */
  disabled?: boolean
  onPush: (session: PlannedSession) => Promise<void> | void
}

interface DisabledReason {
  disabled: boolean
  reason: string | null
}

export function disabledReasonFor(
  session: PlannedSession,
  status: StructuredStatus,
  externalDisabled = false,
): DisabledReason {
  if (externalDisabled) return { disabled: true, reason: '操作进行中…' }
  if (!isPushable(session)) {
    return { disabled: true, reason: '该 session 没有完整 spec，无法推送' }
  }
  if (session.kind !== 'run') {
    return { disabled: true, reason: '当前仅支持跑步 session 推送' }
  }
  if (status === 'backfilled') {
    return { disabled: true, reason: '历史回填，请先在 markdown 视图核对后审核启用' }
  }
  if (status === 'parse_failed') {
    return { disabled: true, reason: '本周计划暂未结构化，请重新解析' }
  }
  if (status === 'stale') {
    return { disabled: true, reason: '结构化已过期，请重新解析' }
  }
  if (status === 'none') {
    return { disabled: true, reason: '本周无结构化计划' }
  }
  if (!isPushableStatus(status)) {
    return { disabled: true, reason: `状态 ${status} 不支持推送` }
  }
  if (session.scheduled_workout_id != null) {
    return { disabled: false, reason: '已推送 — 再次推送会替换手表上的旧条目' }
  }
  return { disabled: false, reason: null }
}

export default function PushPlannedButton({
  session,
  structuredStatus,
  canPushRun,
  disabled = false,
  onPush,
}: PushPlannedButtonProps) {
  const [pushing, setPushing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canPushRun) return null

  const { disabled: gateDisabled, reason } = disabledReasonFor(
    session,
    structuredStatus,
    disabled || pushing,
  )
  const isPushed = session.scheduled_workout_id != null
  const label = pushing ? '推送中…' : isPushed ? '重新推送' : '推送到手表'

  const handle = async () => {
    if (gateDisabled) return
    setPushing(true)
    setError(null)
    try {
      await onPush(session)
    } catch (e) {
      setError(e instanceof Error ? e.message : '推送失败')
    } finally {
      setPushing(false)
    }
  }

  return (
    <div className="inline-flex flex-col items-end">
      <button
        type="button"
        onClick={handle}
        disabled={gateDisabled}
        title={reason ?? undefined}
        aria-label={label}
        className={
          'px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ' +
          (gateDisabled
            ? 'border-border-subtle text-text-muted cursor-not-allowed opacity-60'
            : 'border-accent-green/30 text-accent-green hover:bg-accent-green/10 cursor-pointer')
        }
      >
        {label}
      </button>
      {error && (
        <p className="text-[11px] font-mono text-accent-red mt-1" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
