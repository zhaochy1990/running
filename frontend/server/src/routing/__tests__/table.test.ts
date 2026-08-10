import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { API_ROUTES } from '../api-routes.js'
import {
  AUTH_PREFIX,
  hasGoRoutes,
  hasPartialPlanSetupGoCutover,
  hasPartialWebOnboardingGoCutover,
  PLAN_SETUP_GO_ROUTE_CONTRACT,
  resolveUpstream,
  unsupportedGoRoutes,
  upstreamForRoute,
  WEB_ONBOARDING_GO_ROUTE_CONTRACT,
} from '../table.js'

const TEAM_FEED_AND_LIKES_CUTOVER = {
  STRIDE_ROUTE_GET_TEAMS_TEAMID_FEED: 'go',
  STRIDE_ROUTE_GET_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID_LIKES: 'go',
  STRIDE_ROUTE_POST_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID_LIKES: 'go',
  STRIDE_ROUTE_DELETE_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID_LIKES: 'go',
}

const TEAM_FEED_AND_LIKES_REQUESTS = [
  ['GET', '/api/teams/t1/feed', 'STRIDE_ROUTE_GET_TEAMS_TEAMID_FEED'],
  ['GET', '/api/teams/t1/activities/u1/l1/likes', 'STRIDE_ROUTE_GET_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID_LIKES'],
  ['POST', '/api/teams/t1/activities/u1/l1/likes', 'STRIDE_ROUTE_POST_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID_LIKES'],
  ['DELETE', '/api/teams/t1/activities/u1/l1/likes', 'STRIDE_ROUTE_DELETE_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID_LIKES'],
] as const

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

  it('routes account deletion to Go when enabled', () => {
    const env = { STRIDE_ROUTE_DELETE_USERS_ME: 'go' }
    expect(resolveUpstream('DELETE', '/api/users/me', env)).toBe('go')
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

  it('keeps team sync-all on Python even when every Go-ready team route is cut over', () => {
    const env = Object.fromEntries(
      API_ROUTES.filter((route) => route.goReady && (
        route.path === '/api/users/me/teams' || route.path.startsWith('/api/teams')
      )).map((route) => [route.env, 'go']),
    )
    expect(resolveUpstream('POST', '/api/teams/t1/sync-all', env)).toBe('python')
  })

  it('can route feed and each likes method to Go independently', () => {
    for (const [method, path, envName] of TEAM_FEED_AND_LIKES_REQUESTS) {
      const env = { [envName]: 'go' }
      for (const [candidateMethod, candidatePath] of TEAM_FEED_AND_LIKES_REQUESTS) {
        expect(resolveUpstream(candidateMethod, candidatePath, env)).toBe(
          candidateMethod === method && candidatePath === path ? 'go' : 'python',
        )
      }
    }
  })

  it('routes feed and all three likes methods together as one atomic cutover unit', () => {
    for (const [method, path] of TEAM_FEED_AND_LIKES_REQUESTS) {
      expect(resolveUpstream(method, path, TEAM_FEED_AND_LIKES_CUTOVER)).toBe('go')
    }
    expect(resolveUpstream('POST', '/api/teams/t1/sync-all', TEAM_FEED_AND_LIKES_CUTOVER)).toBe('python')
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
      STRIDE_ROUTE_GET_USERS_ME_NUTRITION_PREFS: ' GO ',
      STRIDE_ROUTE_GET_USERS_ME_PROFILE: 'go',
    }).map((route) => route.env)).toEqual([
      'STRIDE_ROUTE_GET_HEALTH',
      'STRIDE_ROUTE_GET_USERS_ME_NUTRITION_PREFS',
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
    STRIDE_ROUTE_PATCH_USERS_ME_PROFILE: 'go',
    STRIDE_ROUTE_POST_USERS_ME_WATCH_LOGIN: 'go',
    STRIDE_ROUTE_GET_USERS_ME_INJURIES: 'go',
    STRIDE_ROUTE_POST_USERS_ME_INJURIES: 'go',
    STRIDE_ROUTE_PUT_USERS_ME_INJURIES_INJURYID: 'go',
    STRIDE_ROUTE_DELETE_USERS_ME_INJURIES_INJURYID: 'go',
    STRIDE_ROUTE_POST_USER_SYNC: 'go',
    STRIDE_ROUTE_GET_PIPELINES_RUNID: 'go',
    STRIDE_ROUTE_GET_JOBS_JOBID: 'go',
    STRIDE_ROUTE_POST_USERS_ME_ONBOARDING_COMPLETE: 'go',
  }
  const fullPlanSetupGoEnv = {
    STRIDE_ROUTE_GET_USERS_ME_TRAINING_GOAL: 'go',
    STRIDE_ROUTE_POST_USERS_ME_TRAINING_GOAL: 'go',
    STRIDE_ROUTE_POST_USER_SYNC: 'go',
    STRIDE_ROUTE_GET_PIPELINES_RUNID: 'go',
  }

  it('allows no onboarding Go routes or the complete route set', () => {
    expect(hasPartialWebOnboardingGoCutover({})).toBe(false)
    expect(hasPartialWebOnboardingGoCutover(fullWebOnboardingGoEnv)).toBe(false)
  })

  it('rejects every partial onboarding combination', () => {
    const routeNames = Object.keys(fullWebOnboardingGoEnv)
    for (const routeName of routeNames) {
      const partial = { ...fullWebOnboardingGoEnv }
      delete partial[routeName as keyof typeof partial]
      expect(hasPartialWebOnboardingGoCutover(partial)).toBe(true)
    }
  })

  it('allows no plan-setup Go routes or the complete route set', () => {
    expect(hasPartialPlanSetupGoCutover({})).toBe(false)
    expect(hasPartialPlanSetupGoCutover(fullPlanSetupGoEnv)).toBe(false)
  })

  it('rejects every partial plan-setup combination', () => {
    const routeNames = Object.keys(fullPlanSetupGoEnv)
    for (const routeName of routeNames) {
      const partial = { ...fullPlanSetupGoEnv }
      delete partial[routeName as keyof typeof partial]
      expect(hasPartialPlanSetupGoCutover(partial)).toBe(true)
    }
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

  it('keeps the Web onboarding Go cutover as the exact 12-route contract', () => {
    expect(WEB_ONBOARDING_GO_ROUTE_CONTRACT).toEqual([
      { method: 'GET', path: '/api/users/me/profile', env: 'STRIDE_ROUTE_GET_USERS_ME_PROFILE' },
      { method: 'POST', path: '/api/users/me/profile', env: 'STRIDE_ROUTE_POST_USERS_ME_PROFILE' },
      { method: 'PATCH', path: '/api/users/me/profile', env: 'STRIDE_ROUTE_PATCH_USERS_ME_PROFILE' },
      { method: 'POST', path: '/api/users/me/watch/login', env: 'STRIDE_ROUTE_POST_USERS_ME_WATCH_LOGIN' },
      { method: 'GET', path: '/api/users/me/injuries', env: 'STRIDE_ROUTE_GET_USERS_ME_INJURIES' },
      { method: 'POST', path: '/api/users/me/injuries', env: 'STRIDE_ROUTE_POST_USERS_ME_INJURIES' },
      { method: 'PUT', path: '/api/users/me/injuries/:injuryId', env: 'STRIDE_ROUTE_PUT_USERS_ME_INJURIES_INJURYID' },
      { method: 'DELETE', path: '/api/users/me/injuries/:injuryId', env: 'STRIDE_ROUTE_DELETE_USERS_ME_INJURIES_INJURYID' },
      { method: 'POST', path: '/api/:user/sync', env: 'STRIDE_ROUTE_POST_USER_SYNC' },
      { method: 'GET', path: '/api/pipelines/:run_id', env: 'STRIDE_ROUTE_GET_PIPELINES_RUNID' },
      { method: 'GET', path: '/api/jobs/:job_id', env: 'STRIDE_ROUTE_GET_JOBS_JOBID' },
      { method: 'POST', path: '/api/users/me/onboarding/complete', env: 'STRIDE_ROUTE_POST_USERS_ME_ONBOARDING_COMPLETE' },
    ])
    expect(PLAN_SETUP_GO_ROUTE_CONTRACT).toEqual([
      { method: 'GET', path: '/api/users/me/training-goal', env: 'STRIDE_ROUTE_GET_USERS_ME_TRAINING_GOAL' },
      { method: 'POST', path: '/api/users/me/training-goal', env: 'STRIDE_ROUTE_POST_USERS_ME_TRAINING_GOAL' },
      { method: 'POST', path: '/api/:user/sync', env: 'STRIDE_ROUTE_POST_USER_SYNC' },
      { method: 'GET', path: '/api/pipelines/:run_id', env: 'STRIDE_ROUTE_GET_PIPELINES_RUNID' },
    ])
  })

  it('keeps the unified current season-plan route and removes the legacy training-plan route', () => {
    expect(API_ROUTES).toContainEqual({
      method: 'GET',
      path: '/api/users/me/master-plan/current',
      env: 'STRIDE_ROUTE_GET_USERS_ME_MASTER_PLAN_CURRENT',
      goReady: true,
    })
    expect(API_ROUTES.some((route) => route.path === '/api/:user/training-plan')).toBe(false)
  })

  it('defaults the production Web image current season-plan route to Go', () => {
    const dockerfile = readFileSync(new URL('../../../../../Dockerfile.web', import.meta.url), 'utf8')
    expect(dockerfile).toContain('STRIDE_ROUTE_GET_USERS_ME_MASTER_PLAN_CURRENT=go')
  })

  it('goReady endpoints are exactly the ones the Go API implements', () => {
    const goReady = API_ROUTES.filter((r) => r.goReady).map((r) => `${r.method} ${r.path}`).sort()
    expect(goReady).toEqual(
      [
        'DELETE /api/users/me',
        'DELETE /api/users/me/injuries/:injuryId',
        'DELETE /api/teams/:teamId',
        'DELETE /api/teams/:teamId/activities/:userId/:labelId/likes',
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
        'GET /api/pipelines/:run_id',
        'GET /api/jobs/:job_id',
        'GET /api/teams',
        'GET /api/teams/:teamId',
        'GET /api/teams/:teamId/activities/:userId/:labelId',
        'GET /api/teams/:teamId/activities/:userId/:labelId/likes',
        'GET /api/teams/:teamId/feed',
        'GET /api/teams/:teamId/members',
        'GET /api/teams/:teamId/mileage',
        'GET /api/users/me/master-plan/current',
        'GET /api/users/me/profile',
        'GET /api/users/me/teams',
        'GET /api/users/me/training-goal',
        'GET /api/users/me/watch',
        'GET /api/users/:user/pipelines',
        'GET /api/users/me/injuries',
        'POST /api/users/me/onboarding/complete',
        'POST /api/teams',
        'POST /api/teams/:teamId/activities/:userId/:labelId/likes',
        'POST /api/teams/:teamId/join',
        'POST /api/teams/:teamId/leave',
        'POST /api/teams/:teamId/transfer-owner',
        'POST /api/users/me/injuries',
        'POST /api/users/me/profile',
        'POST /api/users/me/watch/login',
        'POST /api/users/me/training-goal',
        'POST /api/:user/sync',
        'PUT /api/users/me/injuries/:injuryId',
        'PATCH /api/users/me/profile',
        'PUT /api/users/me/training-goal',
      ].sort(),
    )
  })
})
