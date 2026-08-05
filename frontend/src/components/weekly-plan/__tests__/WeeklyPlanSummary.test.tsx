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

const structuredDays: PlanDay[] = [{
  date: '2026-07-13',
  nutrition: null,
  sessions: [
    {
      id: 1,
      pushable: false,
      schema: 'plan-session/v1',
      date: '2026-07-13',
      session_index: 0,
      kind: 'run',
      summary: '马拉松配速跑',
      spec: null,
      notes_md: 'Z3',
      total_distance_m: 25000,
      total_duration_s: null,
      scheduled_workout_id: null,
    },
    {
      id: 2,
      pushable: false,
      schema: 'plan-session/v1',
      date: '2026-07-13',
      session_index: 1,
      kind: 'strength',
      summary: '力量维护',
      spec: null,
      notes_md: null,
      total_distance_m: null,
      total_duration_s: 1800,
      scheduled_workout_id: null,
    },
  ],
}]

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

  it('shows the complete intensity breakdown and strength count', () => {
    render(<WeeklyPlanSummary week={week} days={structuredDays} />)

    expect(screen.getByRole('group', { name: 'Z3' })).toHaveTextContent('25.0 km')
    expect(screen.getByRole('group', { name: '力量课' })).toHaveTextContent('1')
  })

  it('renders the current week Coach notes from canonical plan data', () => {
    render(
      <WeeklyPlanSummary
        week={{ ...week, structured: { structured_status: 'fresh', coach_notes: '仅当前用户本周备注' } }}
        days={days}
      />,
    )

    expect(screen.getByText('“仅当前用户本周备注”')).toBeInTheDocument()
  })
})
