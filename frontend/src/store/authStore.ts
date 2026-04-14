import { create } from 'zustand'

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
  login: (email: string, password: string) => Promise<void>
  logout: () => void
  hydrate: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  userId: null,
  isAuthenticated: false,

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
    })

    scheduleTokenRefresh()
  },

  logout: () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    sessionStorage.clear()
    set({ accessToken: null, userId: null, isAuthenticated: false })
  },

  hydrate: () => {
    const accessToken = sessionStorage.getItem('access_token')
    const refreshToken = sessionStorage.getItem('refresh_token')

    if (accessToken && refreshToken) {
      try {
        const payload = decodeJwt(accessToken)
        if (payload.exp * 1000 > Date.now()) {
          set({ accessToken, userId: payload.sub, isAuthenticated: true })
          scheduleTokenRefresh()
          return
        }
      } catch { /* invalid token, fall through */ }
    }

    sessionStorage.clear()
    set({ accessToken: null, userId: null, isAuthenticated: false })
  },
}))

export { refreshAccessToken }
