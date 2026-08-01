/**
 * API routing resolver — the Python→Go strangler seam (ADR 0017).
 *
 * The BFF proxies every browser `/api/*` call to exactly one upstream. This
 * module decides which one, driven by the versioned manifest in `api-routes.ts`
 * (the single source of truth you edit to migrate an endpoint) plus the special
 * case of `/api/auth/*`, which always goes to the auth-service.
 *
 * Matching is method-aware and most-specific-wins: among the manifest entries
 * whose method matches and whose path pattern matches segment-for-segment, the
 * one with the most literal (non-`:param`) segments wins. So
 * `/api/users/me/master-plan/draft` beats `/api/users/me/master-plan/:planId`.
 * Anything unmatched defaults to Python (safe: nothing silently goes to Go).
 */

import { API_ROUTES } from './api-routes.js'

export type Upstream = 'python' | 'go' | 'auth'

/** Prefix under which the in-house auth-service is reached (same-origin via BFF). */
export const AUTH_PREFIX = '/api/auth'

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
 * Resolve which upstream a request goes to. `/api/auth/*` → auth; otherwise the
 * best-matching manifest entry's upstream; otherwise Python.
 */
export function resolveUpstream(method: string, pathname: string): Upstream {
  if (matchesPrefix(pathname, AUTH_PREFIX)) return 'auth'

  const wantedMethod = method.toUpperCase()
  const pathSegs = segments(pathname)
  let bestScore = -1
  let bestUpstream: Upstream = 'python'
  for (const route of API_ROUTES) {
    if (route.method !== wantedMethod) continue
    const score = matchScore(pathSegs, route.path)
    if (score > bestScore) {
      bestScore = score
      bestUpstream = route.upstream
    }
  }
  return bestUpstream
}

/** True when any manifest entry is currently routed to Go (used at boot to
 *  require GO_API_URL). */
export function hasGoRoutes(): boolean {
  return API_ROUTES.some((route) => route.upstream === 'go')
}
