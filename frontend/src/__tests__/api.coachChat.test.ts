/**
 * Pin the coach-chat API client contract: request shape, response shape,
 * 401-retry behavior, and error propagation.
 *
 * `sendCoachChatMessage` is the single public entry-point for
 * POST /api/users/me/coach/chat. The coach answer is `reply` (see
 * src/stride_server/routes/coach.py ChatResponse) — there is no `message_md`.
 * Non-401 failures resolve to `{ ok: false }` per the project postJSON
 * convention; only an unrecoverable 401 throws "Session expired".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const refreshMock = vi.hoisted(() => vi.fn())

vi.mock('../store/authStore', () => ({
  refreshAccessToken: refreshMock,
}))

import { fetchCoachHistory, sendCoachChatMessage } from '../api'

function resp(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function chatBody(reply: string) {
  return {
    session_id: 'web-default',
    thread_id: 'u:coach:web-default',
    reply,
    assistant_message: {
      role: 'assistant',
      message_id: 'msg-abc',
      turn_id: 'abc123',
      created_at: '2026-07-18T00:00:00Z',
      parts: [{ kind: 'text', text: reply }],
    },
    clarification: null,
    active_target: null,
    proposals: [],
  }
}

beforeEach(() => {
  sessionStorage.clear()
  sessionStorage.setItem('access_token', 'tok-test')
  refreshMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendCoachChatMessage', () => {
  it('sends POST to /api/users/me/coach/chat with method, Content-Type, and body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(200, chatBody('# 结论')))
    vi.stubGlobal('fetch', fetchMock)

    await sendCoachChatMessage('我最近练得怎么样？', 'turn-1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/users/me/coach/chat')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    const sentBody = JSON.parse(init.body as string)
    // client_turn_id is required and session defaults to web-default.
    expect(sentBody).toMatchObject({
      message: '我最近练得怎么样？',
      session_id: 'web-default',
      client_turn_id: 'turn-1',
    })
  })

  it('always sends the required client_turn_id (second positional arg)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(200, chatBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await sendCoachChatMessage('测试', 'abc123')

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(sentBody).toMatchObject({ client_turn_id: 'abc123' })
  })

  it('includes the authoritative target when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(200, chatBody('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await sendCoachChatMessage('测试', 'abc123', 'web-default', {
      kind: 'week',
      folder: '2026-06-22_06-28(W8)',
    })

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(sentBody.target).toMatchObject({ kind: 'week', folder: '2026-06-22_06-28(W8)' })
  })

  it('returns { ok, status, data.reply } on success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(200, chatBody('### 结论\n你的跑量稳定。')))
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendCoachChatMessage('测试', 'turn-1')

    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.data.reply).toBe('### 结论\n你的跑量稳定。')
    expect(result.data.assistant_message.turn_id).toBe('abc123')
  })

  it('retries the original request after a successful 401 token refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(401))
      .mockResolvedValueOnce(resp(200, chatBody('重试成功')))
    vi.stubGlobal('fetch', fetchMock)
    refreshMock.mockResolvedValueOnce(undefined)

    const result = await sendCoachChatMessage('问题', 'turn-1')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(refreshMock).toHaveBeenCalledTimes(1)
    // Both calls must be POST to the same URL — retry must not lose method/body.
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('/api/users/me/coach/chat')
      expect(init.method).toBe('POST')
      expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    }
    expect(result.ok).toBe(true)
  })

  it('clears the session and throws "Session expired" when refresh fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(401))
    vi.stubGlobal('fetch', fetchMock)
    refreshMock.mockRejectedValueOnce(new Error('refresh denied'))

    await expect(sendCoachChatMessage('问题', 'turn-1')).rejects.toThrow('Session expired')
    expect(sessionStorage.length).toBe(0)
  })

  it('resolves to { ok: false } on a non-401 error without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(503, { detail: 'unavailable' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendCoachChatMessage('问题', 'turn-1')

    expect(result.ok).toBe(false)
    expect(result.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(refreshMock).not.toHaveBeenCalled()
  })
})

describe('fetchCoachHistory', () => {
  it('GETs the sessions endpoint with only the session id (no thread id)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      resp(200, {
        session_id: 'web-default',
        thread_id: 'u:coach:web-default',
        user_id: 'u',
        debug: false,
        messages: [],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchCoachHistory('web-default')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/users/me/coach/sessions/web-default/messages')
    expect(init.method).toBe('GET')
    expect(result.ok).toBe(true)
    expect(result.data.debug).toBe(false)
  })
})
