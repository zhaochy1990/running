import type { DiffChange } from './types'

interface DiffReviewProps {
  readonly changes: readonly DiffChange[]
}

const CHANGE_LABEL: Record<DiffChange['changeType'], string> = {
  add: '新增',
  update: '调整',
  remove: '移除',
}

const CHANGE_TONE: Record<DiffChange['changeType'], string> = {
  add: 'text-accent-green',
  update: 'text-accent-cyan',
  remove: 'text-accent-red',
}

/**
 * Renders a list of field-level changes with old → new values. Used by both the
 * weekly and master diff Reviews. The whole proposal is applied as one unit; no
 * per-change checkboxes.
 */
export function DiffReview({ changes }: DiffReviewProps) {
  return (
    <ul className="space-y-3">
      {changes.map((change) => (
        <li
          key={change.opId}
          className="rounded-lg border border-border-subtle bg-bg-primary p-3"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-text-primary">{change.label}</span>
            <span className={`text-xs font-medium ${CHANGE_TONE[change.changeType]}`}>
              {CHANGE_LABEL[change.changeType]}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            {change.oldValue != null && (
              <span className="text-text-muted line-through">{change.oldValue}</span>
            )}
            {change.oldValue != null && change.newValue != null && (
              <>
                <span aria-hidden className="text-text-muted">
                  →
                </span>
                <span className="sr-only">变更为</span>
              </>
            )}
            {change.newValue != null && (
              <span className="text-text-primary">{change.newValue}</span>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
