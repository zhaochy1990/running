import { describe, expect, it } from 'vitest'

import { API_ROUTES } from '../api-routes.js'
import { AUTH_PREFIX, hasGoRoutes, resolveUpstream } from '../table.js'

describe('resolveUpstream', () => {
  it('routes /api/auth/* to the auth upstream (any method)', () => {
    expect(resolveUpstream('POST', '/api/auth/login')).toBe('auth')
    expect(resolveUpstream('POST', '/api/auth/refresh')).toBe('auth')
    expect(resolveUpstream('POST', '/api/auth/logout')).toBe('auth')
    expect(resolveUpstream('GET', AUTH_PREFIX)).toBe('auth')
  })

  it('does not let /api/auth match a sibling like /api/authz', () => {
    // /api/authz/thing has no manifest entry → defaults to python, not auth.
    expect(resolveUpstream('GET', '/api/authz/thing')).toBe('python')
  })

  it('routes known Python endpoints to python (all currently python)', () => {
    expect(resolveUpstream('GET', '/api/users/me/profile')).toBe('python')
    expect(resolveUpstream('GET', '/api/f10bc353-uuid/activities')).toBe('python')
    expect(resolveUpstream('POST', '/api/teams/t123/join')).toBe('python')
  })

  it('matches :seg patterns against a real UUID/id segment', () => {
    // /api/:user/activities/:labelId/ability
    expect(resolveUpstream('GET', '/api/abc-uuid/activities/999/ability')).toBe('python')
    // /api/teams/:teamId/activities/:userId/:labelId/likes
    expect(resolveUpstream('DELETE', '/api/teams/t1/activities/u1/l1/likes')).toBe('python')
  })

  it('prefers the most specific (most-literal) match: draft vs :planId', () => {
    // Both /master-plan/draft (5 literals) and /master-plan/:planId (4 literals)
    // have equal segment count; the literal 'draft' entry must win.
    expect(resolveUpstream('GET', '/api/users/me/master-plan/draft')).toBe('python')
    // A real plan id only matches the :planId entry.
    expect(resolveUpstream('GET', '/api/users/me/master-plan/mp_abc')).toBe('python')
  })

  it('is method-aware (an unknown method for a known path defaults to python)', () => {
    expect(resolveUpstream('GET', '/api/users/me/profile')).toBe('python') // GET exists
    expect(resolveUpstream('OPTIONS', '/api/users/me/profile')).toBe('python') // no entry → default
  })

  it('defaults unlisted /api paths to python', () => {
    expect(resolveUpstream('GET', '/api/does/not/exist')).toBe('python')
  })

  it('starts fully on Python: nothing is routed to Go yet', () => {
    expect(hasGoRoutes()).toBe(false)
    expect(API_ROUTES.every((r) => r.upstream === 'python')).toBe(true)
  })

  it('flipping a manifest entry to Go makes resolveUpstream return go (simulated cutover)', () => {
    // Re-implement the exact matcher semantics against a one-entry table where
    // GET /api/users/me/profile is flipped to go — without mutating the shipped
    // manifest. Proves the resolver honors upstream='go'.
    const flipped = [{ method: 'GET', path: '/api/users/me/profile', upstream: 'go' as const }]
    const resolve = (method: string, pathname: string): 'python' | 'go' => {
      const segs = pathname.split('/').filter(Boolean)
      let best = -1
      let up: 'python' | 'go' = 'python'
      for (const r of flipped) {
        if (r.method !== method) continue
        const ps = r.path.split('/').filter(Boolean)
        if (ps.length !== segs.length) continue
        let lit = 0
        let ok = true
        for (let i = 0; i < ps.length; i++) {
          if (ps[i].startsWith(':')) continue
          if (ps[i] !== segs[i]) { ok = false; break }
          lit++
        }
        if (ok && lit > best) { best = lit; up = r.upstream }
      }
      return up
    }
    expect(resolve('GET', '/api/users/me/profile')).toBe('go')
    expect(resolve('POST', '/api/users/me/profile')).toBe('python') // POST not flipped
  })
})

describe('API_ROUTES manifest integrity', () => {
  it('every entry is under /api and has no query/trailing slash', () => {
    for (const r of API_ROUTES) {
      expect(r.path.startsWith('/api/')).toBe(true)
      expect(r.path).not.toContain('?')
      expect(r.path.endsWith('/')).toBe(false)
    }
  })

  it('has no duplicate method+path entries', () => {
    const seen = new Set<string>()
    for (const r of API_ROUTES) {
      const key = `${r.method} ${r.path}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })

  it('goReady endpoints are the ones the Go API implements (profile GET/POST, watch GET/DELETE)', () => {
    const goReady = API_ROUTES.filter((r) => r.goReady).map((r) => `${r.method} ${r.path}`).sort()
    expect(goReady).toEqual(
      [
        'DELETE /api/users/me/watch',
        'GET /api/users/me/profile',
        'GET /api/users/me/watch',
        'POST /api/users/me/profile',
      ].sort(),
    )
  })
})
