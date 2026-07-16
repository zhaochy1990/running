import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  getWeeks: vi.fn(),
  getMyProfile: vi.fn(),
}))
const routerMocks = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock('../../api', () => ({
  getWeeks: apiMocks.getWeeks,
  getMyProfile: apiMocks.getMyProfile,
  getWeek: vi.fn(),
  getWeekStrength: vi.fn(),
  getPlanDays: vi.fn(),
  updateWeeklyFeedback: vi.fn(),
  pushPlannedSession: vi.fn(),
}))
vi.mock('../../UserContextValue', () => ({ useUser: () => ({ user: 'user-id' }) }))
vi.mock('../../lib/shanghai', () => ({ shanghaiToday: () => '2026-07-16' }))
vi.mock('react-router-dom', () => ({
  useNavigate: () => routerMocks.navigate,
  useParams: () => ({}),
}))

import { useCoachWeeklyPlan } from '../useCoachWeeklyPlan'

describe('useCoachWeeklyPlan', () => {
  beforeEach(() => {
    apiMocks.getWeeks.mockReset()
    apiMocks.getMyProfile.mockReset()
    routerMocks.navigate.mockReset()
    apiMocks.getMyProfile.mockResolvedValue({ provider: 'coros' })
  })

  it('finishes loading when the user has no training weeks', async () => {
    apiMocks.getWeeks.mockResolvedValue({ weeks: [] })

    const { result } = renderHook(() => useCoachWeeklyPlan())

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.week).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('opens the current week when the API lists a future week first', async () => {
    apiMocks.getWeeks.mockResolvedValue({
      weeks: [
        { folder: '2026-07-20_07-26', date_from: '2026-07-20', date_to: '2026-07-26' },
        { folder: '2026-07-13_07-19', date_from: '2026-07-13', date_to: '2026-07-19' },
      ],
    })

    renderHook(() => useCoachWeeklyPlan())

    await waitFor(() => {
      expect(routerMocks.navigate).toHaveBeenCalledWith('/week/2026-07-13_07-19', { replace: true })
    })
  })
})
