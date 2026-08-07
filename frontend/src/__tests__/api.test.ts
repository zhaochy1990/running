/**
 * Pin the 401-refresh behavior on api.ts so the upcoming apiFetch
 * consolidation can't silently drop it. The full module has 70+ public
 * endpoint wrappers — we exercise the behavior through `getUsers`
 * (uses `fetchJSON`) and `postOnboardingComplete` (uses `postJSON`),
 * which is enough since all 5 wrappers share the same retry shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const refreshMock = vi.hoisted(() => vi.fn())

vi.mock('../store/authStore', () => ({
  refreshAccessToken: refreshMock,
}))

// Import after the vi.mock registration (vi.mock auto-hoists, but
// being explicit keeps the read order obvious).
import { getUsers, postOnboardingComplete, triggerSync } from '../api'

function resp(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  sessionStorage.clear()
  sessionStorage.setItem('access_token', 'tok-old')
  refreshMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api 401-refresh', () => {
  it('retries the original request after a successful token refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(401))
      .mockResolvedValueOnce(resp(200, { users: ['zhaochaoyi'] }))
    vi.stubGlobal('fetch', fetchMock)
    refreshMock.mockResolvedValueOnce(undefined)

    await expect(getUsers()).resolves.toEqual({ users: ['zhaochaoyi'] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(refreshMock).toHaveBeenCalledTimes(1)
    // Both calls hit the same URL with the same method.
    expect(fetchMock.mock.calls[0][0]).toBe('/api/users')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/users')
  })

  it('clears the session and throws "Session expired" when refresh fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(401))
    vi.stubGlobal('fetch', fetchMock)
    refreshMock.mockRejectedValueOnce(new Error('refresh denied'))

    await expect(getUsers()).rejects.toThrow('Session expired')
    expect(sessionStorage.length).toBe(0)
    // We don't assert on window.location.href — jsdom's behavior around
    // navigation is awkward and the user-visible side effect is the
    // sessionStorage clear + the thrown error, which the redirect just
    // hangs off of.
  })

  it('propagates non-401 errors without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(500, { error: 'boom' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getUsers()).rejects.toThrow('API error: 500')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('posts a completed pipeline run when finalizing onboarding', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(200, { state: 'complete' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(postOnboardingComplete('run-123')).resolves.toEqual({
      ok: true,
      status: 200,
      data: { state: 'complete' },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/users/me/onboarding/complete',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ run_id: 'run-123' }),
      }),
    )
  })

  it('retries onboarding completion with the original POST request after a 401', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(401))
      .mockResolvedValueOnce(resp(200, { state: 'done' }))
    vi.stubGlobal('fetch', fetchMock)
    refreshMock.mockResolvedValueOnce(undefined)

    const out = await postOnboardingComplete('run-123')
    expect(out).toEqual({ ok: true, status: 200, data: { state: 'done' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('/api/users/me/onboarding/complete')
      expect(init.method).toBe('POST')
      expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
      expect(init.body).toBe(JSON.stringify({ run_id: 'run-123' }))
    }
  })

  it('sends an idempotency key when starting a full sync', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(202, { run_id: 'run-1', pipeline_name: 'onboarding' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(triggerSync('user-1', { full: true, idempotencyKey: 'start-key' })).resolves.toMatchObject({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/user-1/sync',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json', 'Idempotency-Key': 'start-key' }),
        body: JSON.stringify({ mode: 'full' }),
      }),
    )
  })
})
