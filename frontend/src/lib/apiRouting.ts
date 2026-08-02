/**
 * Client-side API routing (ADR 0017 interim: frontend on Azure, backend split
 * between Azure + Tencent).
 *
 * The stride-web BFF owns the routing manifest (frontend/server/src/routing/
 * api-routes.ts). Because the BFF runs on Azure, proxying a Tencent-bound call
 * through it crosses the border twice. So the BFF *injects* its manifest +
 * gateway URL into the SPA (`window.__STRIDE_ROUTING__`), and the browser sends
 * Tencent-bound requests (auth + Go) DIRECT to the Tencent gateway — one
 * in-country hop — while Python/Azure requests stay relative `/api/*` and flow
 * same-origin through the Azure BFF.
 *
 * The resolver below MIRRORS the BFF's `resolveUpstream` (method-aware,
 * most-specific-wins) EXACTLY so the browser's direct/relative decision matches
 * what the BFF would have proxied — otherwise a more-specific Python route could
 * be wrongly sent to the Tencent gateway. Keep the two in sync.
 *
 * Degrades gracefully: no injection (dev, or the future post-备案 state where
 * the frontend is co-located with the backend) → `directBaseUrl` empty → every
 * request is relative and the BFF proxies it same-origin.
 */

type Upstream = 'python' | 'go' | 'auth'

interface StrideRoute {
  method: string
  /** Path pattern under /api; `:seg` matches one segment. */
  path: string
  upstream: 'python' | 'go'
}

interface StrideRoutingConfig {
  /** Absolute base the browser calls directly for Tencent-bound endpoints. */
  directBaseUrl?: string
  /** Prefix always routed to the auth-service (Tencent). */
  authPrefix?: string
  /** The BFF's route manifest (only injected when directBaseUrl is set). */
  routes?: StrideRoute[]
}

declare global {
  interface Window {
    __STRIDE_ROUTING__?: StrideRoutingConfig
  }
}

const DEFAULT_AUTH_PREFIX = '/api/auth'

function segments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean)
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true
  const boundary = prefix.endsWith('/') ? prefix : `${prefix}/`
  return pathname.startsWith(boundary)
}

/** Literal-segment count when `pattern` matches `pathSegs`, else -1. Mirrors the
 *  BFF's matchScore (a `:seg` token matches any one segment; counts must match). */
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

/** Mirror of the BFF's resolveUpstream: auth prefix → auth; else the
 *  most-specific matching manifest entry's upstream; else python. */
function resolveUpstream(
  method: string,
  pathname: string,
  routes: StrideRoute[],
  authPrefix: string,
): Upstream {
  if (matchesPrefix(pathname, authPrefix)) return 'auth'
  const wantedMethod = method.toUpperCase()
  const pathSegs = segments(pathname)
  let bestScore = -1
  let bestUpstream: Upstream = 'python'
  for (const route of routes) {
    if (route.method.toUpperCase() !== wantedMethod) continue
    const score = matchScore(pathSegs, route.path)
    if (score > bestScore) {
      bestScore = score
      bestUpstream = route.upstream
    }
  }
  return bestUpstream
}

/**
 * Resolve the fetch URL for a request. Returns an absolute URL to the Tencent
 * gateway when this method+path resolves to a Tencent upstream (auth or Go),
 * otherwise the path unchanged (relative → same-origin → Azure BFF).
 */
export function apiUrl(method: string, fullPath: string): string {
  const cfg = typeof window !== 'undefined' ? window.__STRIDE_ROUTING__ : undefined
  if (!cfg?.directBaseUrl) return fullPath
  const upstream = resolveUpstream(
    method,
    fullPath,
    cfg.routes ?? [],
    cfg.authPrefix ?? DEFAULT_AUTH_PREFIX,
  )
  return upstream === 'python' ? fullPath : `${cfg.directBaseUrl}${fullPath}`
}
