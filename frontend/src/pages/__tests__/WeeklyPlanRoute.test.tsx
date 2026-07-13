import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const userState = vi.hoisted(() => ({ profileReady: true, coachAgentWeeklyPlan: false }))

vi.mock('../../UserContextValue', () => ({ useUser: () => userState }))
vi.mock('../WeekLayout', () => ({ default: () => <div>LEGACY_WEEKLY_PLAN</div> }))
vi.mock('../CoachWeeklyPlanPage', () => ({ default: () => <div>COACH_WEEKLY_PLAN</div> }))

import WeeklyPlanRoute from '../WeeklyPlanRoute'

describe('WeeklyPlanRoute', () => {
  beforeEach(() => {
    userState.profileReady = true
    userState.coachAgentWeeklyPlan = false
  })

  it('keeps non-allowlisted users on the legacy page', () => {
    render(<WeeklyPlanRoute />)
    expect(screen.getByText('LEGACY_WEEKLY_PLAN')).toBeInTheDocument()
    expect(screen.queryByText('COACH_WEEKLY_PLAN')).not.toBeInTheDocument()
  })

  it('shows the Coach Agent UI for allowlisted users', () => {
    userState.coachAgentWeeklyPlan = true
    render(<WeeklyPlanRoute />)
    expect(screen.getByText('COACH_WEEKLY_PLAN')).toBeInTheDocument()
  })

  it('waits until the profile capability is known', () => {
    userState.profileReady = false
    const { container } = render(<WeeklyPlanRoute />)
    expect(container.querySelector('.animate-spin')).toBeInTheDocument()
    expect(screen.queryByText('LEGACY_WEEKLY_PLAN')).not.toBeInTheDocument()
  })
})
