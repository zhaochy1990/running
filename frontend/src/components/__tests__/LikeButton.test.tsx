import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LikeButton from '../LikeButton'

// Mock the api module — we drive UI logic, not network paths.
vi.mock('../../api', () => ({
  likeActivity: vi.fn(),
  unlikeActivity: vi.fn(),
  getActivityLikes: vi.fn(),
}))

import * as api from '../../api'

const TEAM = 'team-1'
const USER = 'a1b2c3d4-e5f6-4aaa-89ab-111111111111'
const LABEL = 'act-001'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LikeButton', () => {
  it('shows initial count and liked state', () => {
    render(
      <LikeButton
        teamId={TEAM} userId={USER} labelId={LABEL}
        initialCount={3} initialLiked={true}
      />,
    )
    expect(screen.getByRole('button', { name: '取消点赞' })).toBeInTheDocument()
    // Both heart and "X 人赞过" show the same count.
    expect(screen.getAllByText('3').length).toBeGreaterThan(0)
  })

  it('optimistically increments on like and calls likeActivity', async () => {
    const mockLike = vi.mocked(api.likeActivity)
    mockLike.mockResolvedValue({
      ok: true, status: 200,
      data: { liked: true, count: 1, you_liked: true },
    })

    render(
      <LikeButton
        teamId={TEAM} userId={USER} labelId={LABEL}
        initialCount={0} initialLiked={false}
      />,
    )
    const heart = screen.getByRole('button', { name: '点赞' })
    await act(async () => {
      fireEvent.click(heart)
    })
    expect(mockLike).toHaveBeenCalledWith(TEAM, USER, LABEL)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '取消点赞' })).toBeInTheDocument()
    })
  })

  it('reverts on like failure and shows error', async () => {
    const mockLike = vi.mocked(api.likeActivity)
    mockLike.mockResolvedValue({ ok: false, status: 500, data: { liked: false, count: 0, you_liked: false } })

    render(
      <LikeButton
        teamId={TEAM} userId={USER} labelId={LABEL}
        initialCount={0} initialLiked={false}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '点赞' }))
    })
    await waitFor(() => {
      // Reverted: still not liked.
      expect(screen.getByRole('button', { name: '点赞' })).toBeInTheDocument()
    })
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument()
  })

  it('calls unlikeActivity when already liked', async () => {
    const mockUnlike = vi.mocked(api.unlikeActivity)
    mockUnlike.mockResolvedValue({
      ok: true, status: 200,
      data: { liked: false, count: 0, you_liked: false },
    })

    render(
      <LikeButton
        teamId={TEAM} userId={USER} labelId={LABEL}
        initialCount={1} initialLiked={true}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消点赞' }))
    })
    expect(mockUnlike).toHaveBeenCalledWith(TEAM, USER, LABEL)
  })

  it('opens popover and lazy-loads likers when "N 人赞过" is clicked', async () => {
    const mockGet = vi.mocked(api.getActivityLikes)
    mockGet.mockResolvedValue({
      count: 2,
      you_liked: false,
      likers: [
        { user_id: 'u1', display_name: 'Alice', created_at: '2026-05-04T10:00:00Z' },
        { user_id: 'u2', display_name: 'Bob', created_at: '2026-05-04T11:00:00Z' },
      ],
    })

    render(
      <LikeButton
        teamId={TEAM} userId={USER} labelId={LABEL}
        initialCount={2} initialLiked={false}
      />,
    )
    const trigger = screen.getByText('2 人赞过')
    await act(async () => {
      fireEvent.click(trigger)
    })
    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument()
      expect(screen.getByText('Bob')).toBeInTheDocument()
    })
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  it('does not show "N 人赞过" when count is 0', () => {
    render(
      <LikeButton
        teamId={TEAM} userId={USER} labelId={LABEL}
        initialCount={0} initialLiked={false}
      />,
    )
    expect(screen.queryByText(/人赞过/)).toBeNull()
  })
})
