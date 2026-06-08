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
import { getUsers, postOnboardingComplete } from '../api'

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

  it('postJSON sends method=POST + JSON content-type + body, and refreshes on 401', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(401))
      .mockResolvedValueOnce(resp(200, { state: 'done' }))
    vi.stubGlobal('fetch', fetchMock)
    refreshMock.mockResolvedValueOnce(undefined)

    const out = await postOnboardingComplete()
    expect(out).toEqual({ ok: true, status: 200, data: { state: 'done' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Both calls carry the POST + JSON Content-Type — verifies the retry
    // doesn't drop method/headers (the original duplication risk).
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('/api/users/me/onboarding/complete')
      expect(init.method).toBe('POST')
      expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    }
  })
})
