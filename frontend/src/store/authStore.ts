import { create } from 'zustand'
import { setAuthUser, clearAuthUser } from '../telemetry/appInsights'

const AUTH_BASE = import.meta.env.VITE_AUTH_BASE_URL || ''
const CLIENT_ID = import.meta.env.VITE_AUTH_CLIENT_ID || ''

interface JwtPayload {
  sub: string
  exp: number
  role?: string
}

function decodeJwt(token: string): JwtPayload {
  const base64Url = token.split('.')[1]
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
  const json = decodeURIComponent(
    atob(base64)
      .split('')
      .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
      .join(''),
  )
  return JSON.parse(json)
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null

function clearBrowserSession() {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  void clearAuthUser()
  sessionStorage.clear()
}

async function refreshAccessToken(): Promise<string> {
  const refreshToken = sessionStorage.getItem('refresh_token')
  if (!refreshToken) throw new Error('No refresh token')

  const res = await fetch(`${AUTH_BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })

  if (!res.ok) throw new Error('Refresh failed')

  const data = await res.json()
  sessionStorage.setItem('access_token', data.access_token)
  sessionStorage.setItem('refresh_token', data.refresh_token)
  return data.access_token as string
}

function scheduleTokenRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer)
  const token = sessionStorage.getItem('access_token')
  if (!token) return

  try {
    const payload = decodeJwt(token)
    const msUntilExpiry = payload.exp * 1000 - Date.now()
    const delay = Math.max(msUntilExpiry - 60_000, 1_000)
    refreshTimer = setTimeout(async () => {
      try {
        await refreshAccessToken()
        scheduleTokenRefresh()
      } catch { /* will redirect on next 401 */ }
    }, delay)
  } catch { /* invalid token */ }
}

interface AuthState {
  accessToken: string | null
  userId: string | null
  isAuthenticated: boolean
  hydrated: boolean
  login: (email: string, password: string) => Promise<void>
  registerSuccess: (access_token: string, refresh_token: string) => void
  logout: () => Promise<void>
  clearSession: () => void
  hydrate: () => void
}

export function useUserId(): string | null {
  return useAuthStore((s) => s.userId)
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  userId: null,
  isAuthenticated: false,
  hydrated: false,

  login: async (email: string, password: string) => {
    const res = await fetch(`${AUTH_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
      body: JSON.stringify({ email, password }),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw { status: res.status, error: data.error }
    }

    const { access_token, refresh_token } = await res.json()
    const payload = decodeJwt(access_token)

    sessionStorage.setItem('access_token', access_token)
    sessionStorage.setItem('refresh_token', refresh_token)

    set({
      accessToken: access_token,
      userId: payload.sub,
      isAuthenticated: true,
      hydrated: true,
    })

    void setAuthUser(payload.sub)
    scheduleTokenRefresh()
  },

  registerSuccess: (access_token: string, refresh_token: string) => {
    const payload = decodeJwt(access_token)
    sessionStorage.setItem('access_token', access_token)
    sessionStorage.setItem('refresh_token', refresh_token)
    set({
      accessToken: access_token,
      userId: payload.sub,
      isAuthenticated: true,
      hydrated: true,
    })
    void setAuthUser(payload.sub)
    scheduleTokenRefresh()
  },

  logout: async () => {
    const refreshToken = sessionStorage.getItem('refresh_token')

    if (refreshToken && AUTH_BASE) {
      try {
        await fetch(`${AUTH_BASE}/api/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
          body: JSON.stringify({ refresh_token: refreshToken }),
        })
      } catch { /* best-effort: server-side revocation may fail; local cleanup still runs */ }
    }

    clearBrowserSession()
    set({
      accessToken: null,
      userId: null,
      isAuthenticated: false,
      hydrated: true,
    })
  },

  clearSession: () => {
    clearBrowserSession()
    set({
      accessToken: null,
      userId: null,
      isAuthenticated: false,
      hydrated: true,
    })
  },

  hydrate: () => {
    const accessToken = sessionStorage.getItem('access_token')
    const refreshToken = sessionStorage.getItem('refresh_token')

    if (accessToken && refreshToken) {
      try {
        const payload = decodeJwt(accessToken)
        if (payload.exp * 1000 > Date.now()) {
          set({
            accessToken,
            userId: payload.sub,
            isAuthenticated: true,
            hydrated: true,
          })
          void setAuthUser(payload.sub)
          scheduleTokenRefresh()
          return
        }
      } catch { /* invalid token, fall through */ }
    }

    clearBrowserSession()
    set({
      accessToken: null,
      userId: null,
      isAuthenticated: false,
      hydrated: true,
    })
  },
}))

export { refreshAccessToken }
