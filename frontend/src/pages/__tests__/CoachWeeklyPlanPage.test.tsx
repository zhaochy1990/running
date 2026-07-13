import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoachWeeklyPlanState } from '../../hooks/useCoachWeeklyPlan'

const weeklyPlanState = vi.hoisted(() => ({ current: null as CoachWeeklyPlanState | null }))

vi.mock('../../hooks/useCoachWeeklyPlan', () => ({
  useCoachWeeklyPlan: () => weeklyPlanState.current,
}))

import CoachWeeklyPlanPage from '../CoachWeeklyPlanPage'

const emptyState: CoachWeeklyPlanState = {
  week: null,
  weeks: [],
  planDays: [],
  strength: null,
  loading: false,
  error: null,
  saveFeedback: vi.fn(),
}

describe('CoachWeeklyPlanPage', () => {
  beforeEach(() => {
    weeklyPlanState.current = emptyState
  })

  it('prompts users to generate a plan when no training week exists', () => {
    render(<CoachWeeklyPlanPage />)

    expect(screen.getByRole('heading', { name: '使用 Coach Agent 生成本周计划' })).toBeInTheDocument()
    expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
  })

  it('prompts users to generate a plan when the selected week has no plan', () => {
    weeklyPlanState.current = {
      ...emptyState,
      week: {
        folder: '2026-07-13_07-19',
        date_from: '2026-07-13',
        date_to: '2026-07-19',
        activities: [],
        activity_count: 0,
        total_km: 0,
        total_duration_s: 0,
        total_duration_fmt: '0m',
      },
    }

    render(<CoachWeeklyPlanPage />)

    expect(screen.getByRole('heading', { name: '使用 Coach Agent 生成本周计划' })).toBeInTheDocument()
  })
})
