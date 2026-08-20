import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/**
 * A one-time success banner shown after a coach proposal is applied. It reads
 * the `coachPlanApplied` flag from `location.state`, then immediately replaces
 * the history entry to strip the flag so a refresh / back navigation does not
 * re-show it.
 */
export function CoachPlanAppliedBanner() {
  const location = useLocation()
  const navigate = useNavigate()
  const flagged = Boolean(
    (location.state as { coachPlanApplied?: unknown } | null)?.coachPlanApplied,
  )
  const [visible, setVisible] = useState(flagged)

  useEffect(() => {
    if (!flagged) return
    // Strip the flag from history so it never re-fires.
    navigate(location.pathname + location.search, { replace: true, state: null })
  }, [flagged, navigate, location.pathname, location.search])

  if (!visible) return null

  return (
    <div
      role="status"
      className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-accent-green/30 bg-accent-green/10 px-4 py-2.5 text-sm text-text-primary"
    >
      <span>计划已更新。</span>
      <button
        type="button"
        aria-label="知道了，关闭计划更新提示"
        className="rounded px-2 py-0.5 text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-green"
        onClick={() => setVisible(false)}
      >
        知道了
      </button>
    </div>
  )
}
