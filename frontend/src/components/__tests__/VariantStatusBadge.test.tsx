import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import VariantStatusBadge from '../VariantStatusBadge'

describe('VariantStatusBadge', () => {
  it('renders fresh status with green color', () => {
    render(<VariantStatusBadge status="fresh" />)
    const badge = screen.getByTestId('variant-status-badge')
    expect(badge).toHaveAttribute('data-key', 'fresh')
    expect(badge).toHaveStyle({ background: '#dcfce7' })
  })

  it('renders parse_failed status with red color', () => {
    render(<VariantStatusBadge status="parse_failed" />)
    const badge = screen.getByTestId('variant-status-badge')
    expect(badge).toHaveAttribute('data-key', 'parse_failed')
    expect(badge).toHaveStyle({ background: '#fee2e2' })
  })

  it('unselectableReason overrides parse_status', () => {
    // A fresh-parsed variant that's been superseded should show as superseded.
    render(
      <VariantStatusBadge status="fresh" unselectableReason="superseded" />,
    )
    const badge = screen.getByTestId('variant-status-badge')
    expect(badge).toHaveAttribute('data-key', 'superseded')
    expect(badge).toHaveStyle({ background: '#e5e7eb' })
  })

  it('schema_outdated reason renders amber chip', () => {
    render(
      <VariantStatusBadge status="fresh" unselectableReason="schema_outdated" />,
    )
    const badge = screen.getByTestId('variant-status-badge')
    expect(badge).toHaveAttribute('data-key', 'schema_outdated')
    expect(badge).toHaveStyle({ background: '#fef3c7' })
  })
})
