/**
 * Integration tests for useCoachChat that require a real user context:
 * history load-on-mount (with ids), load-failure gating, contextAnchor
 * filtering, authoritative target on every send, auto-replay of a persisted
 * pending turn, id dedup, and same-turn-id replay on retry.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { UserContext } from '../../UserContextValue'

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

function wrapper({ children }: { children: ReactNode }) {
  return (
    <UserContext.Provider
      value={{ user: 'user-1', displayName: 'A', profileReady: true, refresh: async () => {} }}
    >
      {children}
    </UserContext.Provider>
  )
}

function historyResp(messages: unknown[]) {
  return {
    ok: true,
    status: 200,
    data: {
      session_id: 'web-default',
      thread_id: 'user-1:coach:web-default',
      user_id: 'user-1',
      debug: false,
      messages,
    },
  }
}

function chatResp(reply: string, ids?: { messageId?: string; turnId?: string }) {
  return {
    ok: true,
    status: 200,
    data: {
      session_id: 'web-default',
      thread_id: 'user-1:coach:web-default',
      reply,
      assistant_message: {
        role: 'assistant',
        message_id: ids?.messageId ?? 'msg-x',
        turn_id: ids?.turnId ?? 'turn-x',
        created_at: '2026-07-18T00:00:00Z',
        parts: [{ kind: 'text', text: reply }],
      },
      clarification: null,
      active_target: null,
      proposals: [],
    },
  }
}

// The 2nd positional arg to sendCoachChatMessage is clientTurnId; the 4th is target.
const CLIENT_TURN_ID_ARG = 1
const TARGET_ARG = 3

describe('useCoachChat — history + replay', () => {
  beforeEach(() => {
    sessionStorage.clear()
    apiMocks.sendCoachChatMessage.mockReset()
    apiMocks.fetchCoachHistory.mockReset()
  })

  it('loads full history on mount and maps assistant parts + ids to views', async () => {
    apiMocks.fetchCoachHistory.mockResolvedValueOnce(
      historyResp([
        { role: 'user', content: '上周怎么样', parts: [], message_id: 'm0' },
        {
          role: 'assistant',
          content: '',
          parts: [{ kind: 'text', text: '很稳定' }],
          message_id: 'm1',
          turn_id: 't1',
          created_at: '2026-07-18T01:00:00Z',
        },
      ]),
    )
    const { result } = renderHook(() => useCoachChat(), { wrapper })

    await waitFor(() => expect(result.current.historyLoading).toBe(false))
    expect(result.current.messages).toEqual([
      expect.objectContaining({ role: 'user', content: '上周怎么样', messageId: 'm0' }),
      expect.objectContaining({
        role: 'coach',
        content: '很稳定',
        messageId: 'm1',
        turnId: 't1',
        createdAt: '2026-07-18T01:00:00Z',
      }),
    ])
  })

  it('sets historyError and blocks the transcript when the load fails', async () => {
    apiMocks.fetchCoachHistory.mockResolvedValueOnce({ ok: false, status: 503, data: {} })
    const { result } = renderHook(() => useCoachChat(), { wrapper })

    await waitFor(() => expect(result.current.historyError).toBeTruthy())
    expect(result.current.messages).toEqual([])
  })

  it('filters history to messages at/after contextAnchor (workspace mode)', async () => {
    apiMocks.fetchCoachHistory.mockResolvedValueOnce(
      historyResp([
        { role: 'user', content: '早期问题', parts: [], message_id: 'm0' },
        { role: 'assistant', content: '', parts: [{ kind: 'text', text: '早期回答' }], message_id: 'm1' },
        { role: 'user', content: '锚点问题', parts: [], message_id: 'm2' },
        { role: 'assistant', content: '', parts: [{ kind: 'text', text: '锚点回答' }], message_id: 'm3' },
      ]),
    )
    const { result } = renderHook(() => useCoachChat({ contextAnchor: 'm2' }), { wrapper })

    await waitFor(() => expect(result.current.historyLoading).toBe(false))
    expect(result.current.messages.map((m) => m.content)).toEqual(['锚点问题', '锚点回答'])
  })

  it('sends the authoritative target on every send (workspace mode)', async () => {
    apiMocks.fetchCoachHistory.mockResolvedValueOnce(historyResp([]))
    apiMocks.sendCoachChatMessage.mockResolvedValue(chatResp('ok'))
    const target = { kind: 'week' as const, folder: '2026-06-22_06-28(W8)' }
    const { result } = renderHook(() => useCoachChat({ target }), { wrapper })
    await waitFor(() => expect(result.current.historyLoading).toBe(false))

    await act(async () => {
      result.current.sendMessage('问题')
    })
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(apiMocks.sendCoachChatMessage.mock.calls[0][TARGET_ARG]).toMatchObject(target)
  })

  it('auto-replays a persisted pending turn after history load with the same id', async () => {
    sessionStorage.setItem(
      'stride.coach.pendingTurn',
      JSON.stringify({ sessionId: 'web-default', clientTurnId: 'pending-42', message: '未完成的问题' }),
    )
    apiMocks.fetchCoachHistory.mockResolvedValueOnce(historyResp([]))
    apiMocks.sendCoachChatMessage.mockResolvedValueOnce(chatResp('恢复后的回复'))
    const { result } = renderHook(() => useCoachChat(), { wrapper })

    await waitFor(() => expect(apiMocks.sendCoachChatMessage).toHaveBeenCalledTimes(1))
    expect(apiMocks.sendCoachChatMessage.mock.calls[0][CLIENT_TURN_ID_ARG]).toBe('pending-42')
    await waitFor(() => expect(result.current.loading).toBe(false))
    // The pending user message is present, and the coach reply landed.
    expect(result.current.messages.some((m) => m.role === 'user' && m.content === '未完成的问题')).toBe(true)
    expect(result.current.messages.some((m) => m.role === 'coach')).toBe(true)
  })

  it('does not replay when the pending turn already landed in history', async () => {
    sessionStorage.setItem(
      'stride.coach.pendingTurn',
      JSON.stringify({ sessionId: 'web-default', clientTurnId: 'echoed-1', message: '已落库的问题' }),
    )
    apiMocks.fetchCoachHistory.mockResolvedValueOnce(
      historyResp([
        { role: 'user', content: '已落库的问题', parts: [], message_id: 'mu' },
        {
          role: 'assistant',
          content: '',
          parts: [{ kind: 'text', text: '已有回答' }],
          message_id: 'ma',
          turn_id: 'echoed-1',
        },
      ]),
    )
    const { result } = renderHook(() => useCoachChat(), { wrapper })

    await waitFor(() => expect(result.current.historyLoading).toBe(false))
    expect(apiMocks.sendCoachChatMessage).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('stride.coach.pendingTurn')).toBeNull()
  })

  it('maps role="event" history rows to compact event views (shown to everyone)', async () => {
    apiMocks.fetchCoachHistory.mockResolvedValueOnce(
      historyResp([
        { role: 'user', content: '帮我降量', parts: [], message_id: 'm0' },
        {
          role: 'event',
          content: '',
          parts: [],
          event_type: 'weekly_plan_applied',
          status: 'applied',
          summary: '已启用本周课表调整',
          detail: { folder: '2026-07-13_07-19', applied_op_ids: ['op1'] },
          message_id: 'ev1',
          created_at: '2026-07-18T02:00:00Z',
        },
      ]),
    )
    const { result } = renderHook(() => useCoachChat(), { wrapper })

    await waitFor(() => expect(result.current.historyLoading).toBe(false))
    const event = result.current.messages.find((m) => m.role === 'event')
    expect(event).toEqual(
      expect.objectContaining({
        role: 'event',
        content: '已启用本周课表调整',
        eventType: 'weekly_plan_applied',
        eventStatus: 'applied',
        messageId: 'ev1',
      }),
    )
    expect(event?.eventDetail).toMatchObject({ folder: '2026-07-13_07-19' })
  })

  it('includes an event row when it falls at/after contextAnchor', async () => {
    apiMocks.fetchCoachHistory.mockResolvedValueOnce(
      historyResp([
        { role: 'user', content: '早期', parts: [], message_id: 'm0' },
        { role: 'user', content: '锚点问题', parts: [], message_id: 'm2' },
        {
          role: 'event',
          content: '',
          parts: [],
          event_type: 'proposal_abandoned',
          status: 'abandoned',
          summary: '已放弃该调整方案',
          message_id: 'ev9',
        },
      ]),
    )
    const { result } = renderHook(() => useCoachChat({ contextAnchor: 'm2' }), { wrapper })

    await waitFor(() => expect(result.current.historyLoading).toBe(false))
    expect(result.current.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', '锚点问题'],
      ['event', '已放弃该调整方案'],
    ])
  })

  it('reuses the same client_turn_id when retrying a failed send', async () => {
    apiMocks.fetchCoachHistory.mockResolvedValueOnce(historyResp([]))
    apiMocks.sendCoachChatMessage
      .mockRejectedValueOnce(new Error('网络错误'))
      .mockResolvedValueOnce(chatResp('重试成功'))
    const { result } = renderHook(() => useCoachChat(), { wrapper })
    await waitFor(() => expect(result.current.historyLoading).toBe(false))

    await act(async () => {
      result.current.sendMessage('问题')
    })
    await waitFor(() => expect(result.current.error).toBeTruthy())
    const firstTurnId = apiMocks.sendCoachChatMessage.mock.calls[0][CLIENT_TURN_ID_ARG]

    await act(async () => {
      result.current.retry()
    })
    await waitFor(() => expect(result.current.loading).toBe(false))

    const secondTurnId = apiMocks.sendCoachChatMessage.mock.calls[1][CLIENT_TURN_ID_ARG]
    expect(firstTurnId).toBeTruthy()
    expect(secondTurnId).toBe(firstTurnId)
  })

  it('dedups the coach turn by message id (no double append on same id)', async () => {
    apiMocks.fetchCoachHistory.mockResolvedValueOnce(historyResp([]))
    apiMocks.sendCoachChatMessage
      .mockResolvedValueOnce(chatResp('第一次', { messageId: 'dup-1' }))
      .mockResolvedValueOnce(chatResp('第二次', { messageId: 'dup-1' }))
    const { result } = renderHook(() => useCoachChat(), { wrapper })
    await waitFor(() => expect(result.current.historyLoading).toBe(false))

    await act(async () => {
      result.current.sendMessage('一')
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      result.current.sendMessage('二')
    })
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Two user messages, but only ONE coach message (second was deduped by id).
    const coachMsgs = result.current.messages.filter((m) => m.role === 'coach')
    expect(coachMsgs).toHaveLength(1)
  })
})
