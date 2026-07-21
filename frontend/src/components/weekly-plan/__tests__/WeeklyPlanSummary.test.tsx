import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import WeeklyPlanSummary from '../WeeklyPlanSummary'
import type { PlanDay, WeekDetail } from '../../../api'

const week: WeekDetail = {
  folder: '2026-07-13_07-19',
  date_from: '2026-07-13',
  date_to: '2026-07-19',
  activities: [],
  activity_count: 0,
  total_km: 0,
  total_duration_s: 0,
  total_duration_fmt: '0m',
}

const days: PlanDay[] = []

describe('WeeklyPlanSummary 调整本周 CTA', () => {
  it('disables the CTA when no onAdjust is provided', () => {
    render(<WeeklyPlanSummary week={week} days={days} />)
    expect(screen.getByRole('button', { name: '调整本周' })).toBeDisabled()
  })

  it('enables the CTA and fires onAdjust when provided', () => {
    const onAdjust = vi.fn()
    render(<WeeklyPlanSummary week={week} days={days} onAdjust={onAdjust} />)
    const btn = screen.getByRole('button', { name: '调整本周' })
    expect(btn).not.toBeDisabled()
    fireEvent.click(btn)
    expect(onAdjust).toHaveBeenCalledTimes(1)
  })
})
