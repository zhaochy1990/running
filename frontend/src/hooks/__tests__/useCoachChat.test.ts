/**
 * Behavioral tests for useCoachChat hook.
 *
 * Covers: initial state, loading lifecycle, optimistic user message append,
 * successful coach reply append, error handling with message retention,
 * retry, empty/whitespace guard, and concurrent-send guard.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  sendCoachChatMessage: vi.fn(),
  fetchCoachHistory: vi.fn(),
}))

vi.mock('../../api', () => ({
  sendCoachChatMessage: apiMocks.sendCoachChatMessage,
  fetchCoachHistory: apiMocks.fetchCoachHistory,
  WEB_DEFAULT_SESSION_ID: 'web-default',
}))

import { clearPendingCoachTurnForWeek, useCoachChat } from '../useCoachChat'

function makeSuccessResp(reply: string) {
  return {
    ok: true,
    status: 200,
    data: {
      session_id: 'web-default',
      thread_id: 'u:coach:web-default',
      reply,
      assistant_message: {
        role: 'assistant',
        message_id: `msg-${reply}`,
        turn_id: `turn-${reply}`,
        created_at: '2026-07-18T00:00:00Z',
        parts: [{ kind: 'text', text: reply }],
      },
      clarification: null,
      active_target: null,
      proposals: [],
    },
  }
}

describe('useCoachChat', () => {
  beforeEach(() => {
    sessionStorage.clear()
    apiMocks.sendCoachChatMessage.mockReset()
    apiMocks.fetchCoachHistory.mockReset()
    apiMocks.fetchCoachHistory.mockResolvedValue({
      ok: true,
      status: 200,
      data: { session_id: 'web-default', thread_id: 'u:coach:web-default', user_id: 'u', debug: false, messages: [] },
    })
  })

  it('starts with empty messages, loading=false, error=null', () => {
    const { result } = renderHook(() => useCoachChat())

    expect(result.current.messages).toEqual([])
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('sets loading=true immediately when sendMessage is called', async () => {
    // Never resolves during this test — we just check the synchronous flip.
    apiMocks.sendCoachChatMessage.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useCoachChat())

    act(() => { result.current.sendMessage('问题') })

    expect(result.current.loading).toBe(true)
  })

  it('optimistically appends the user message before the API resolves', async () => {
    // Use a deferred promise so we can inspect state mid-flight.
    let resolveApi!: (v: unknown) => void
    apiMocks.sendCoachChatMessage.mockReturnValue(new Promise((res) => { resolveApi = res }))
    const { result } = renderHook(() => useCoachChat())

    act(() => { result.current.sendMessage('我最近练得怎么样？') })

    // User message must be visible before API resolves.
    expect(result.current.messages.some((m) => m.role === 'user' && m.content === '我最近练得怎么样？')).toBe(true)

    // Clean up: resolve so no dangling promise.
    act(() => { resolveApi(makeSuccessResp('ok')) })
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it('appends the coach reply and clears loading on API success', async () => {
    apiMocks.sendCoachChatMessage.mockResolvedValueOnce(
      makeSuccessResp('### 结论\n你的跑量稳定。'),
    )
    const { result } = renderHook(() => useCoachChat())

    await act(async () => { result.current.sendMessage('问题') })

    await waitFor(() => expect(result.current.loading).toBe(false))
    const coachMsg = result.current.messages.find((m) => m.role === 'coach')
    expect(coachMsg).toBeDefined()
    expect(coachMsg?.content).toBe('### 结论\n你的跑量稳定。')
    expect(result.current.error).toBeNull()
  })

  it('retains the user message and sets error on API failure', async () => {
    apiMocks.sendCoachChatMessage.mockRejectedValueOnce(new Error('网络错误'))
    const { result } = renderHook(() => useCoachChat())

    await act(async () => { result.current.sendMessage('问题') })

    await waitFor(() => expect(result.current.loading).toBe(false))
    // User's message is still in the list.
    expect(result.current.messages.some((m) => m.role === 'user')).toBe(true)
    // Error is surfaced.
    expect(result.current.error).toBeTruthy()
  })

  it('retry() re-sends the last message and clears the error', async () => {
    apiMocks.sendCoachChatMessage
      .mockRejectedValueOnce(new Error('网络错误'))
      .mockResolvedValueOnce(makeSuccessResp('重试后的回复'))
    const { result } = renderHook(() => useCoachChat())

    await act(async () => { result.current.sendMessage('问题') })
    await waitFor(() => expect(result.current.error).toBeTruthy())

    await act(async () => { result.current.retry() })
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBeNull()
    expect(result.current.messages.some((m) => m.role === 'coach')).toBe(true)
    // sendCoachChatMessage was called twice total.
    expect(apiMocks.sendCoachChatMessage).toHaveBeenCalledTimes(2)
  })

  it('does not call the API when the message is an empty string', async () => {
    const { result } = renderHook(() => useCoachChat())

    await act(async () => { result.current.sendMessage('') })

    expect(apiMocks.sendCoachChatMessage).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
  })

  it('does not call the API or persist a turn when the message exceeds the limit', async () => {
    const { result } = renderHook(() => useCoachChat())

    await act(async () => { result.current.sendMessage('x'.repeat(8001)) })

    expect(apiMocks.sendCoachChatMessage).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('stride.coach.pendingTurn')).toBeNull()
  })

  it('does not call the API when the message is only whitespace', async () => {
    const { result } = renderHook(() => useCoachChat())

    await act(async () => { result.current.sendMessage('   \n\t  ') })

    expect(apiMocks.sendCoachChatMessage).not.toHaveBeenCalled()
  })

  it('ignores a second sendMessage call while the first is still pending', async () => {
    let resolveFirst!: (v: unknown) => void
    apiMocks.sendCoachChatMessage.mockReturnValueOnce(
      new Promise((res) => { resolveFirst = res }),
    )
    const { result } = renderHook(() => useCoachChat())

    act(() => { result.current.sendMessage('第一条') })
    // While first is in-flight, fire a second.
    act(() => { result.current.sendMessage('第二条') })

    // API called exactly once.
    expect(apiMocks.sendCoachChatMessage).toHaveBeenCalledTimes(1)

    act(() => { resolveFirst(makeSuccessResp('回复')) })
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it('passes the review context on send and reuses the same snapshot on retry', async () => {
    const reviewContext = {
      kind: 'weekly_create' as const,
      proposal: { folder: '2026-06-22_06-28(W8)' },
    }
    apiMocks.sendCoachChatMessage
      .mockRejectedValueOnce(new Error('网络错误'))
      .mockResolvedValueOnce(makeSuccessResp('草案逻辑'))
    const { result } = renderHook(() =>
      useCoachChat({
        target: { kind: 'week', folder: '2026-06-22_06-28(W8)' },
        reviewContext,
      }),
    )

    await act(async () => { result.current.sendMessage('这个课表的训练逻辑是什么') })
    await waitFor(() => expect(result.current.error).toBeTruthy())

    // First send carried the draft as the 5th positional arg.
    expect(apiMocks.sendCoachChatMessage.mock.calls[0][4]).toEqual(reviewContext)

    await act(async () => { result.current.retry() })
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Retry replays the identical context snapshot.
    expect(apiMocks.sendCoachChatMessage.mock.calls[1][4]).toEqual(reviewContext)
  })

  it('passes undefined review context for an ordinary chat', async () => {
    apiMocks.sendCoachChatMessage.mockResolvedValueOnce(makeSuccessResp('ok'))
    const { result } = renderHook(() => useCoachChat())

    await act(async () => { result.current.sendMessage('我状态如何') })
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(apiMocks.sendCoachChatMessage.mock.calls[0][4]).toBeUndefined()
  })

  it('persists a complete request snapshot (target + context) with the pending turn', async () => {
    const target = { kind: 'week' as const, folder: '2026-06-22_06-28(W8)' }
    const reviewContext = {
      kind: 'weekly_create' as const,
      proposal: { folder: '2026-06-22_06-28(W8)' },
    }
    // Never resolves — inspect the persisted pending record mid-flight.
    apiMocks.sendCoachChatMessage.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useCoachChat({ target, reviewContext }))

    act(() => { result.current.sendMessage('这个课表的训练逻辑是什么') })

    const raw = sessionStorage.getItem('stride.coach.pendingTurn')
    expect(raw).toBeTruthy()
    const pending = JSON.parse(raw as string)
    expect(pending.requestSnapshot).toEqual({ target, reviewContext })
  })

  it('persists explicit null in the snapshot for an ordinary chat', async () => {
    apiMocks.sendCoachChatMessage.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useCoachChat())

    act(() => { result.current.sendMessage('我状态如何') })

    const pending = JSON.parse(sessionStorage.getItem('stride.coach.pendingTurn') as string)
    expect(pending.requestSnapshot).toEqual({ target: null, reviewContext: null })
  })

  it('clears only a pending review turn anchored to the applied or discarded week', () => {
    const pending = {
      sessionId: 'web-default',
      clientTurnId: 'pending-review',
      message: '把周三改轻一点',
      requestSnapshot: {
        target: { kind: 'week', folder: '2026-07-20_07-26' },
        reviewContext: {
          kind: 'weekly_create',
          proposal: { folder: '2026-07-20_07-26' },
        },
      },
    }
    sessionStorage.setItem('stride.coach.pendingTurn', JSON.stringify(pending))

    clearPendingCoachTurnForWeek('2026-07-27_08-02')
    expect(sessionStorage.getItem('stride.coach.pendingTurn')).not.toBeNull()

    clearPendingCoachTurnForWeek('2026-07-20_07-26')
    expect(sessionStorage.getItem('stride.coach.pendingTurn')).toBeNull()
  })

  it('does not clear an ordinary pending turn for the same weekly target', () => {
    sessionStorage.setItem(
      'stride.coach.pendingTurn',
      JSON.stringify({
        sessionId: 'web-default',
        clientTurnId: 'pending-ordinary',
        message: '我今天恢复得怎么样',
        requestSnapshot: {
          target: { kind: 'week', folder: '2026-07-20_07-26' },
          reviewContext: null,
        },
      }),
    )

    clearPendingCoachTurnForWeek('2026-07-20_07-26')

    expect(sessionStorage.getItem('stride.coach.pendingTurn')).not.toBeNull()
  })
})
