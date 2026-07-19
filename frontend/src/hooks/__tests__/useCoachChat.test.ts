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

import { useCoachChat } from '../useCoachChat'

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
})
