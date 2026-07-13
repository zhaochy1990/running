import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  getWeeks: vi.fn(),
}))

vi.mock('../../api', () => ({
  getWeeks: apiMocks.getWeeks,
  getWeek: vi.fn(),
  getWeekStrength: vi.fn(),
  getPlanDays: vi.fn(),
  updateWeeklyFeedback: vi.fn(),
}))
vi.mock('../../UserContextValue', () => ({ useUser: () => ({ user: 'user-id' }) }))
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}))

import { useCoachWeeklyPlan } from '../useCoachWeeklyPlan'

describe('useCoachWeeklyPlan', () => {
  beforeEach(() => {
    apiMocks.getWeeks.mockReset()
  })

  it('finishes loading when the user has no training weeks', async () => {
    apiMocks.getWeeks.mockResolvedValue({ weeks: [] })

    const { result } = renderHook(() => useCoachWeeklyPlan())

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.week).toBeNull()
    expect(result.current.error).toBeNull()
  })
})
