import type { CreatePlanDay } from './types'

interface CreateReviewProps {
  readonly days: readonly CreatePlanDay[]
}

/**
 * Full creation Review for a brand-new week (WeeklyCreateProposal). Unlike the
 * diff Review there are no old/new columns — every day is new.
 */
export function CreateReview({ days }: CreateReviewProps) {
  return (
    <ul className="space-y-3">
      {days.map((day, i) => (
        <li
          key={`${day.label}-${i}`}
          className="rounded-lg border border-border-subtle bg-bg-primary p-3"
        >
          <div className="mb-1 text-sm font-medium text-text-primary">{day.label}</div>
          <div className="text-sm text-text-muted">{day.detail}</div>
        </li>
      ))}
    </ul>
  )
}
