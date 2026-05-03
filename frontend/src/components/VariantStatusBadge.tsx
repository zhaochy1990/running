import type { UnselectableReason, VariantParseStatus } from '../types/plan'

interface Props {
  status: VariantParseStatus
  unselectableReason?: UnselectableReason
}

const COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  fresh: { bg: '#dcfce7', fg: '#166534', label: 'fresh' },
  parse_failed: { bg: '#fee2e2', fg: '#991b1b', label: '解析失败' },
  schema_outdated: { bg: '#fef3c7', fg: '#92400e', label: 'schema 过期' },
  superseded: { bg: '#e5e7eb', fg: '#374151', label: '已取代' },
}

/** Status pill for a variant card.
 *
 * Priority: unselectableReason wins over parse_status when set. So a
 * variant with `parse_status='fresh'` but `unselectableReason='superseded'`
 * renders as 已取代 (superseded), not as fresh.
 */
export default function VariantStatusBadge({ status, unselectableReason }: Props) {
  const key = unselectableReason ?? status
  const c = COLORS[key] ?? COLORS.fresh
  return (
    <span
      data-testid="variant-status-badge"
      data-key={key}
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '12px',
        fontSize: '12px',
        fontFamily: 'monospace',
        background: c.bg,
        color: c.fg,
      }}
    >
      {c.label}
    </span>
  )
}
