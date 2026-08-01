/**
 * Versioned API routing table — the Python→Go strangler seam (ADR 0017).
 *
 * The BFF proxies every browser `/api/*` call to exactly one upstream, and this
 * table is the single source of truth for *which* one. The default is Python
 * (`stride-app`). An endpoint moves to Go by adding its prefix to
 * `GO_ROUTE_PREFIXES` **together with** the matching frontend contract change —
 * Go and Python contracts differ per endpoint (e.g. `watch_ready`,
 * `/watch/login`; see ADR 0013), so a cutover is never a pure routing flip.
 *
 * Auth calls (`/api/auth/*`) always go to the auth-service upstream, keeping
 * the browser same-origin (ADR 0017 reverses the old browser-direct auth).
 *
 * Matching is first-segment-aware prefix matching on the URL pathname: a prefix
 * matches when the path equals it or continues with a `/`, so `/api/users` does
 * NOT accidentally match `/api/users-export`.
 */

export type Upstream = 'python' | 'go' | 'auth'

/** Prefix under which the in-house auth-service is reached (same-origin via BFF). */
export const AUTH_PREFIX = '/api/auth'

/**
 * Endpoints already ported to AND verified on the Go API. Add a prefix here to
 * cut it over to Go (paired with its frontend contract change). Intentionally
 * empty at launch: nothing runs on Go until contract parity is proven.
 *
 * Example (enable once the frontend uses `watch_ready` + `/watch/login`):
 *   '/api/users/me/profile',
 */
export const GO_ROUTE_PREFIXES: readonly string[] = []

function matchesPrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true
  const boundary = prefix.endsWith('/') ? prefix : `${prefix}/`
  return pathname.startsWith(boundary)
}

/**
 * Resolve which upstream an `/api/*` request goes to. Callers should only pass
 * pathnames under `/api`; anything else falls through to `python` defensively.
 */
export function resolveUpstream(pathname: string): Upstream {
  if (matchesPrefix(pathname, AUTH_PREFIX)) return 'auth'
  for (const prefix of GO_ROUTE_PREFIXES) {
    if (matchesPrefix(pathname, prefix)) return 'go'
  }
  return 'python'
}
