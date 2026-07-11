import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function makeJwt(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  return `header.${encoded}.signature`
}

describe('authStore local auth routing', () => {
  beforeEach(() => {
    vi.resetModules()
    sessionStorage.clear()
    vi.stubEnv('VITE_AUTH_BASE_URL', 'https://auth.example.test')
    vi.stubEnv('VITE_AUTH_CLIENT_ID', 'app_test')
    vi.stubEnv('VITE_DEV_AUTH_PROXY', 'https://auth.example.test')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  it('uses the Vite auth proxy path for local dev login requests', async () => {
    const accessToken = makeJwt({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: accessToken, refresh_token: 'refresh-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { useAuthStore } = await import('../authStore')

    await useAuthStore.getState().login('runner@example.test', 'password')

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'app_test' },
      body: JSON.stringify({ email: 'runner@example.test', password: 'password' }),
    })
  })

  it('still uses the Vite auth proxy path when only VITE_AUTH_BASE_URL is configured', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_DEV_AUTH_PROXY', '')
    const accessToken = makeJwt({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: accessToken, refresh_token: 'refresh-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { useAuthStore } = await import('../authStore')

    await useAuthStore.getState().login('runner@example.test', 'password')

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'app_test' },
      body: JSON.stringify({ email: 'runner@example.test', password: 'password' }),
    })
  })

  it('falls back to the public STRIDE client id when env injection is absent', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_AUTH_CLIENT_ID', '')
    const accessToken = makeJwt({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: accessToken, refresh_token: 'refresh-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { useAuthStore } = await import('../authStore')

    await useAuthStore.getState().login('runner@example.test', 'password')

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'app_62978bf2803346878a2e4805' },
      body: JSON.stringify({ email: 'runner@example.test', password: 'password' }),
    })
  })
})
