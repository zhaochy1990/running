/**
 * API routing resolver — the Python→Go strangler seam (ADR 0017).
 *
 * The BFF proxies every browser `/api/*` call to exactly one upstream. This
 * module decides which one, driven by the versioned manifest in `api-routes.ts`
 * (the single source of truth for which endpoints exist and which env var
 * controls each) plus the special case of `/api/auth/*`, which always goes to
 * the auth-service.
 *
 * Per-endpoint routing is env-driven: each manifest entry names a `STRIDE_ROUTE_*`
 * variable. When that variable is `go` (case-insensitive, trimmed) the endpoint
 * routes to Go; unset/empty/any other value keeps it on Python. So an operator
 * cuts one endpoint over by setting its env var — no manifest edit / redeploy.
 *
 * Matching is method-aware and most-specific-wins: among the manifest entries
 * whose method matches and whose path pattern matches segment-for-segment, the
 * one with the most literal (non-`:param`) segments wins. So
 * `/api/users/me/master-plan/draft` beats `/api/users/me/master-plan/:planId`.
 * Anything unmatched defaults to Python (safe: nothing silently goes to Go).
 */

import { API_ROUTES, type ApiRoute } from './api-routes.js'

export type Upstream = 'python' | 'go' | 'auth'

/** Prefix under which the in-house auth-service is reached (same-origin via BFF). */
export const AUTH_PREFIX = '/api/auth'

/** Env value (case-insensitive) that opts an endpoint into the Go upstream. */
const GO_ENV_VALUE = 'go'

function segments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean)
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true
  const boundary = prefix.endsWith('/') ? prefix : `${prefix}/`
  return pathname.startsWith(boundary)
}

/**
 * Score a path against a manifest pattern. Returns the count of literal segments
 * matched (higher = more specific), or -1 when it does not match. A `:seg` token
 * matches any single segment; segment counts must be equal.
 */
function matchScore(pathSegs: string[], pattern: string): number {
  const patSegs = segments(pattern)
  if (patSegs.length !== pathSegs.length) return -1
  let literals = 0
  for (let i = 0; i < patSegs.length; i++) {
    if (patSegs[i].startsWith(':')) continue
    if (patSegs[i] !== pathSegs[i]) return -1
    literals++
  }
  return literals
}

/**
 * The upstream a single manifest entry currently resolves to, per its env var.
 * `go` only when the variable is set to `go` (case-insensitive, trimmed);
 * otherwise `python` (the safe default — unset/empty/any other value).
 */
export function upstreamForRoute(
  route: ApiRoute,
  env: NodeJS.ProcessEnv = process.env,
): 'python' | 'go' {
  return env[route.env]?.trim().toLowerCase() === GO_ENV_VALUE ? 'go' : 'python'
}

/**
 * Resolve which upstream a request goes to. `/api/auth/*` → auth; otherwise the
 * best-matching manifest entry's env-selected upstream; otherwise Python.
 */
export function resolveUpstream(
  method: string,
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
): Upstream {
  if (matchesPrefix(pathname, AUTH_PREFIX)) return 'auth'

  const wantedMethod = method.toUpperCase()
  const pathSegs = segments(pathname)
  let bestScore = -1
  let bestRoute: ApiRoute | null = null
  for (const route of API_ROUTES) {
    if (route.method !== wantedMethod) continue
    const score = matchScore(pathSegs, route.path)
    if (score > bestScore) {
      bestScore = score
      bestRoute = route
    }
  }
  return bestRoute ? upstreamForRoute(bestRoute, env) : 'python'
}

/** True when any manifest entry's env var currently routes it to Go (used at
 *  boot to require GO_API_URL). */
export function hasGoRoutes(env: NodeJS.ProcessEnv = process.env): boolean {
  return API_ROUTES.some((route) => upstreamForRoute(route, env) === 'go')
}
