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
        initialTopLikers={['Alice', 'Bob', 'Carol']}
      />,
    )
    expect(screen.getByRole('button', { name: '取消点赞' })).toBeInTheDocument()
    expect(screen.getByText('Alice、Bob、Carol 赞过')).toBeInTheDocument()
  })

  it('shows "等 N 人赞过" when count exceeds top liker names', () => {
    render(
      <LikeButton
        teamId={TEAM} userId={USER} labelId={LABEL}
        initialCount={5} initialLiked={false}
        initialTopLikers={['Alice', 'Bob', 'Carol']}
      />,
    )
    expect(screen.getByText('Alice、Bob、Carol 等 5 人赞过')).toBeInTheDocument()
  })

  it('falls back to "N 人赞过" when top likers list is empty', () => {
    render(
      <LikeButton
        teamId={TEAM} userId={USER} labelId={LABEL}
        initialCount={2} initialLiked={false}
      />,
    )
    expect(screen.getByText('2 人赞过')).toBeInTheDocument()
  })

  it('optimistically prepends caller name on like and calls likeActivity', async () => {
    const mockLike = vi.mocked(api.likeActivity)
    mockLike.mockResolvedValue({
      ok: true, status: 200,
      data: { liked: true, count: 1, you_liked: true },
    })

    render(
      <LikeButton
        teamId={TEAM} userId={USER} labelId={LABEL}
        initialCount={0} initialLiked={false}
        currentUserDisplayName="Me"
      />,
    )
    const heart = screen.getByRole('button', { name: '点赞' })
    await act(async () => {
      fireEvent.click(heart)
    })
    expect(mockLike).toHaveBeenCalledWith(TEAM, USER, LABEL)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '取消点赞' })).toBeInTheDocument()
      expect(screen.getByText('Me 赞过')).toBeInTheDocument()
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
      expect(screen.getByRole('button', { name: '点赞' })).toBeInTheDocument()
    })
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument()
  })

  it('calls unlikeActivity when already liked and removes self from inline list', async () => {
    const mockUnlike = vi.mocked(api.unlikeActivity)
    mockUnlike.mockResolvedValue({
      ok: true, status: 200,
      data: { liked: false, count: 0, you_liked: false },
    })

    render(
      <LikeButton
        teamId={TEAM} userId={USER} labelId={LABEL}
        initialCount={1} initialLiked={true}
        initialTopLikers={['Me']}
        currentUserDisplayName="Me"
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消点赞' }))
    })
    expect(mockUnlike).toHaveBeenCalledWith(TEAM, USER, LABEL)
    await waitFor(() => {
      expect(screen.queryByText(/赞过/)).toBeNull()
    })
  })

  it('opens popover and lazy-loads likers when inline summary is clicked', async () => {
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
        initialTopLikers={['Alice', 'Bob']}
      />,
    )
    const trigger = screen.getByText('Alice、Bob 赞过')
    await act(async () => {
      fireEvent.click(trigger)
    })
    await waitFor(() => {
      // The popover renders a header + <li> entries with each name.
      expect(screen.getByText('点赞的人 (2)')).toBeInTheDocument()
      // Bob only appears alone inside the popover <li>.
      expect(screen.getByText('Bob')).toBeInTheDocument()
    })
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  it('does not show inline summary when count is 0', () => {
    render(
      <LikeButton
        teamId={TEAM} userId={USER} labelId={LABEL}
        initialCount={0} initialLiked={false}
      />,
    )
    expect(screen.queryByText(/赞过/)).toBeNull()
  })
})
