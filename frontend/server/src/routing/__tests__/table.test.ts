import { describe, expect, it } from 'vitest'

import { API_ROUTES } from '../api-routes.js'
import { AUTH_PREFIX, hasGoRoutes, hasPartialWebOnboardingGoCutover, resolveUpstream, unsupportedGoRoutes, upstreamForRoute } from '../table.js'

describe('resolveUpstream', () => {
  it('routes /api/auth/* to the auth upstream (any method)', () => {
    expect(resolveUpstream('POST', '/api/auth/login')).toBe('auth')
    expect(resolveUpstream('POST', '/api/auth/refresh')).toBe('auth')
    expect(resolveUpstream('POST', '/api/auth/logout')).toBe('auth')
    expect(resolveUpstream('GET', AUTH_PREFIX)).toBe('auth')
  })

  it('does not let /api/auth match a sibling like /api/authz', () => {
    // /api/authz/thing has no manifest entry → defaults to python, not auth.
    expect(resolveUpstream('GET', '/api/authz/thing', {})).toBe('python')
  })

  it('routes known endpoints to python by default (no env set)', () => {
    expect(resolveUpstream('GET', '/api/users/me/profile', {})).toBe('python')
    expect(resolveUpstream('GET', '/api/f10bc353-uuid/activities', {})).toBe('python')
    expect(resolveUpstream('POST', '/api/teams/t123/join', {})).toBe('python')
  })

  it('matches :seg patterns against a real UUID/id segment', () => {
    // /api/:user/activities/:labelId/ability
    expect(resolveUpstream('GET', '/api/abc-uuid/activities/999/ability', {})).toBe('python')
    // /api/teams/:teamId/activities/:userId/:labelId/likes
    expect(resolveUpstream('DELETE', '/api/teams/t1/activities/u1/l1/likes', {})).toBe('python')
  })

  it('routes plan week list and detail endpoints to python by default', () => {
    expect(resolveUpstream('GET', '/api/u/plan/weeks', {})).toBe('python')
    expect(resolveUpstream('GET', '/api/u/plan/weeks/2026-W32', {})).toBe('python')
  })

  it('prefers the most specific (most-literal) match: draft vs :planId', () => {
    // Both /master-plan/draft (5 literals) and /master-plan/:planId (4 literals)
    // have equal segment count; the literal 'draft' entry must win.
    expect(resolveUpstream('GET', '/api/users/me/master-plan/draft', {})).toBe('python')
    // A real plan id only matches the :planId entry.
    expect(resolveUpstream('GET', '/api/users/me/master-plan/mp_abc', {})).toBe('python')
  })

  it('is method-aware (an unknown method for a known path defaults to python)', () => {
    expect(resolveUpstream('GET', '/api/users/me/profile', {})).toBe('python') // GET exists
    expect(resolveUpstream('OPTIONS', '/api/users/me/profile', {})).toBe('python') // no entry → default
  })

  it('defaults unlisted /api paths to python', () => {
    expect(resolveUpstream('GET', '/api/does/not/exist', {})).toBe('python')
  })
})

describe('env-driven upstream selection', () => {
  it('routes an endpoint to Go when its env var is exactly "go"', () => {
    const env = { STRIDE_ROUTE_GET_USERS_ME_PROFILE: 'go' }
    expect(resolveUpstream('GET', '/api/users/me/profile', env)).toBe('go')
    // The sibling method (POST) is a different env var → stays python.
    expect(resolveUpstream('POST', '/api/users/me/profile', env)).toBe('python')
  })

  it('is case-insensitive and trims surrounding whitespace on the env value', () => {
    const env = { STRIDE_ROUTE_GET_USERS_ME_PROFILE: '  GO ' }
    expect(resolveUpstream('GET', '/api/users/me/profile', env)).toBe('go')
  })

  it('keeps python for unset, empty, or any non-"go" value', () => {
    expect(resolveUpstream('GET', '/api/users/me/profile', {})).toBe('python')
    expect(resolveUpstream('GET', '/api/users/me/profile', { STRIDE_ROUTE_GET_USERS_ME_PROFILE: '' })).toBe('python')
    expect(resolveUpstream('GET', '/api/users/me/profile', { STRIDE_ROUTE_GET_USERS_ME_PROFILE: 'python' })).toBe('python')
    expect(resolveUpstream('GET', '/api/users/me/profile', { STRIDE_ROUTE_GET_USERS_ME_PROFILE: 'golang' })).toBe('python')
  })

  it('applies the env var of the most-specific matched route only', () => {
    // Flipping the :planId env must not leak onto the more-specific literal draft path.
    const env = { STRIDE_ROUTE_GET_USERS_ME_MASTER_PLAN_PLANID: 'go' }
    expect(resolveUpstream('GET', '/api/users/me/master-plan/mp_abc', env)).toBe('go')
    expect(resolveUpstream('GET', '/api/users/me/master-plan/draft', env)).toBe('python')
  })

  it('switches plan week list and detail routes independently', () => {
    const listEnv = { STRIDE_ROUTE_GET_USER_PLAN_WEEKS: 'go' }
    expect(resolveUpstream('GET', '/api/u/plan/weeks', listEnv)).toBe('go')
    expect(resolveUpstream('GET', '/api/u/plan/weeks/2026-W32', listEnv)).toBe('python')

    const detailEnv = { STRIDE_ROUTE_GET_USER_PLAN_WEEKS_WEEKNAME: 'go' }
    expect(resolveUpstream('GET', '/api/u/plan/weeks', detailEnv)).toBe('python')
    expect(resolveUpstream('GET', '/api/u/plan/weeks/2026-W32', detailEnv)).toBe('go')
  })

  it('keeps the legacy variants path on Python when plan-week detail moves to Go', () => {
    const env = { STRIDE_ROUTE_GET_USER_PLAN_WEEKS_WEEKNAME: 'go' }
    expect(resolveUpstream('GET', '/api/u/plan/weeks/variants', env)).toBe('python')
  })

  it('/api/auth/* is unaffected by any route env var', () => {
    expect(resolveUpstream('POST', '/api/auth/login', { STRIDE_ROUTE_GET_HEALTH: 'go' })).toBe('auth')
  })

  it('upstreamForRoute reflects the entry env var directly', () => {
    const profileGet = API_ROUTES.find((r) => r.method === 'GET' && r.path === '/api/users/me/profile')!
    expect(upstreamForRoute(profileGet, {})).toBe('python')
    expect(upstreamForRoute(profileGet, { [profileGet.env]: 'go' })).toBe('go')
  })
})

describe('hasGoRoutes', () => {
  it('is false when no route env var is set to go', () => {
    expect(hasGoRoutes({})).toBe(false)
  })

  it('is true when at least one route env var is set to go', () => {
    expect(hasGoRoutes({ STRIDE_ROUTE_GET_USER_ACTIVITIES: 'go' })).toBe(true)
  })

  it('ignores non-go values', () => {
    expect(hasGoRoutes({ STRIDE_ROUTE_GET_USER_ACTIVITIES: 'python' })).toBe(false)
  })
})

describe('Go route capability validation', () => {
  it('reports every non-Go-ready route configured to use Go', () => {
    expect(unsupportedGoRoutes({
      STRIDE_ROUTE_GET_HEALTH: 'go',
      STRIDE_ROUTE_POST_USERS_ME_FULL_SYNC: ' GO ',
      STRIDE_ROUTE_GET_USERS_ME_PROFILE: 'go',
    }).map((route) => route.env)).toEqual([
      'STRIDE_ROUTE_GET_HEALTH',
      'STRIDE_ROUTE_POST_USERS_ME_FULL_SYNC',
    ])
  })

  it('allows Go-ready routes and ignores non-Go values', () => {
    expect(unsupportedGoRoutes({
      STRIDE_ROUTE_GET_USERS_ME_PROFILE: 'go',
      STRIDE_ROUTE_GET_HEALTH: 'python',
    })).toEqual([])
  })
})

describe('Web onboarding Go cutover', () => {
  const fullWebOnboardingGoEnv = {
    STRIDE_ROUTE_GET_USERS_ME_PROFILE: 'go',
    STRIDE_ROUTE_POST_USERS_ME_PROFILE: 'go',
    STRIDE_ROUTE_POST_USERS_ME_WATCH_LOGIN: 'go',
    STRIDE_ROUTE_POST_USER_SYNC: 'go',
    STRIDE_ROUTE_GET_PIPELINES_RUNID: 'go',
    STRIDE_ROUTE_POST_USERS_ME_ONBOARDING_COMPLETE: 'go',
  }

  it('allows no onboarding Go routes or the complete route set', () => {
    expect(hasPartialWebOnboardingGoCutover({})).toBe(false)
    expect(hasPartialWebOnboardingGoCutover(fullWebOnboardingGoEnv)).toBe(false)
  })

  it('rejects every partial combination', () => {
    expect(hasPartialWebOnboardingGoCutover({ STRIDE_ROUTE_POST_USER_SYNC: 'go' })).toBe(true)
    expect(hasPartialWebOnboardingGoCutover({
      STRIDE_ROUTE_GET_USERS_ME_PROFILE: 'go',
      STRIDE_ROUTE_POST_USERS_ME_PROFILE: 'go',
      STRIDE_ROUTE_POST_USERS_ME_WATCH_LOGIN: 'go',
      STRIDE_ROUTE_POST_USER_SYNC: 'go',
      STRIDE_ROUTE_GET_PIPELINES_RUNID: 'go',
    })).toBe(true)
  })
})

describe('API_ROUTES manifest integrity', () => {
  it('keeps the legacy weekly plan routes', () => {
    expect(API_ROUTES).toContainEqual({
      method: 'GET',
      path: '/api/:user/weeks',
      env: 'STRIDE_ROUTE_GET_USER_WEEKS',
      goReady: false,
    })
  })

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

  it('every entry has a unique, well-formed STRIDE_ROUTE_* env var name', () => {
    const seen = new Set<string>()
    for (const r of API_ROUTES) {
      expect(r.env).toMatch(/^STRIDE_ROUTE_[A-Z0-9_]+$/)
      expect(seen.has(r.env)).toBe(false)
      seen.add(r.env)
    }
  })

  it('keeps the Web onboarding Go cutover as profile, watch, start, poll, and finalization', () => {
    expect(API_ROUTES.filter((route) => [
      '/api/users/me/profile',
      '/api/users/me/watch/login',
      '/api/:user/sync',
      '/api/pipelines/:runId',
      '/api/users/me/onboarding/complete',
    ].includes(route.path) && ['GET', 'POST'].includes(route.method))).toEqual([
      { method: 'GET', path: '/api/users/me/profile', env: 'STRIDE_ROUTE_GET_USERS_ME_PROFILE', goReady: true },
      { method: 'POST', path: '/api/users/me/profile', env: 'STRIDE_ROUTE_POST_USERS_ME_PROFILE', goReady: true },
      { method: 'POST', path: '/api/users/me/watch/login', env: 'STRIDE_ROUTE_POST_USERS_ME_WATCH_LOGIN', goReady: true },
      { method: 'POST', path: '/api/users/me/onboarding/complete', env: 'STRIDE_ROUTE_POST_USERS_ME_ONBOARDING_COMPLETE', goReady: true },
      { method: 'POST', path: '/api/:user/sync', env: 'STRIDE_ROUTE_POST_USER_SYNC', goReady: true },
      { method: 'GET', path: '/api/pipelines/:runId', env: 'STRIDE_ROUTE_GET_PIPELINES_RUNID', goReady: true },
    ])
  })

  it('goReady endpoints are exactly the ones the Go API implements', () => {
    const goReady = API_ROUTES.filter((r) => r.goReady).map((r) => `${r.method} ${r.path}`).sort()
    expect(goReady).toEqual(
      [
        'DELETE /api/users/me/watch',
        'GET /api/:user/activities',
        'GET /api/:user/activities/:labelId',
        'GET /api/:user/health',
        'GET /api/:user/hrv',
        'GET /api/:user/pmc',
        'GET /api/:user/plan/weeks',
        'GET /api/:user/plan/weeks/:weekName',
        'GET /api/:user/stride/training-load',
        'GET /api/:user/stride/zones',
        'GET /api/:user/training-plan',
        'GET /api/pipelines/:runId',
        'GET /api/users/me/master-plan/current',
        'GET /api/users/me/profile',
        'GET /api/users/me/sync-status',
        'GET /api/users/me/training-goal',
        'GET /api/users/me/watch',
        'GET /api/users/:user/pipelines',
        'POST /api/users/me/onboarding/complete',
        'POST /api/users/me/profile',
        'POST /api/users/me/watch/login',
        'POST /api/users/me/training-goal',
        'POST /api/:user/sync',
        'PUT /api/users/me/training-goal',
      ].sort(),
    )
  })
})
