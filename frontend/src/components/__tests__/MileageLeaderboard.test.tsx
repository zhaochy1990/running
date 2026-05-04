import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MileageLeaderboard from '../MileageLeaderboard'

vi.mock('../../api', () => ({
  getTeamMileage: vi.fn(),
}))

import * as api from '../../api'

const TEAM = 'team-1'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const mockData = (period: 'month' | 'week', rankings: api.MileageRankingEntry[]): api.MileageLeaderboardData => ({
  team_id: TEAM,
  period,
  period_start: '2026-05-01T00:00:00+08:00',
  period_end: '2026-05-04T13:00:00+08:00',
  rankings,
})

describe('MileageLeaderboard', () => {
  it('renders ranked rows with podium emojis for top 3', async () => {
    vi.mocked(api.getTeamMileage).mockResolvedValue(
      mockData('month', [
        { user_id: 'u1', display_name: 'Alice', total_km: 42.5, activity_count: 8 },
        { user_id: 'u2', display_name: 'Bob', total_km: 36.2, activity_count: 6 },
        { user_id: 'u3', display_name: 'Carol', total_km: 28, activity_count: 5 },
        { user_id: 'u4', display_name: 'Dave', total_km: 5.1, activity_count: 1 },
      ]),
    )
    render(<MileageLeaderboard teamId={TEAM} />)
    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument()
    })
    expect(screen.getByText('🥇')).toBeInTheDocument()
    expect(screen.getByText('🥈')).toBeInTheDocument()
    expect(screen.getByText('🥉')).toBeInTheDocument()
    expect(screen.getByText('#4')).toBeInTheDocument()
    expect(screen.getByText('42.5 km')).toBeInTheDocument()
    expect(screen.getByText('8 次')).toBeInTheDocument()
  })

  it('defaults to month and refetches on toggle to week', async () => {
    const mock = vi.mocked(api.getTeamMileage)
    mock.mockImplementation((_id, period) =>
      Promise.resolve(
        mockData(period ?? 'month', [
          { user_id: 'u1', display_name: 'Alice', total_km: period === 'week' ? 8 : 40, activity_count: 1 },
        ]),
      ),
    )

    render(<MileageLeaderboard teamId={TEAM} />)
    await waitFor(() => {
      expect(mock).toHaveBeenCalledWith(TEAM, 'month')
      expect(screen.getByText('40.0 km')).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '本周榜' }))
    })
    await waitFor(() => {
      expect(mock).toHaveBeenCalledWith(TEAM, 'week')
      expect(screen.getByText('8.0 km')).toBeInTheDocument()
    })
  })

  it('shows the period-specific empty state when no rankings', async () => {
    vi.mocked(api.getTeamMileage).mockResolvedValue(mockData('month', []))
    render(<MileageLeaderboard teamId={TEAM} />)
    await waitFor(() => {
      expect(screen.getByText('本月还没人跑过')).toBeInTheDocument()
    })
  })

  it('shows error pill on fetch failure', async () => {
    vi.mocked(api.getTeamMileage).mockRejectedValue(new Error('boom'))
    render(<MileageLeaderboard teamId={TEAM} />)
    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument()
    })
  })
})
