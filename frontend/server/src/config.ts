/**
 * BFF runtime configuration, read once at boot from the environment.
 *
 * The three upstreams are the whole point of the strangler split (ADR 0017):
 *   - PYTHON_API_URL   → stride-app (Azure, same region)   [default upstream]
 *   - GO_API_URL       → `stride api` (Tencent CVM)         [optional until first cutover]
 *   - AUTH_UPSTREAM_URL → in-house auth-service (Azure)     [/api/auth/*]
 */

export interface BffConfig {
  /** Port the BFF listens on. */
  readonly port: number
  /** Default upstream for `/api/*` (stride-app). */
  readonly pythonApiUrl: string
  /** Upstream for endpoints migrated to Go; null when not yet configured. */
  readonly goApiUrl: string | null
  /** Upstream for `/api/auth/*` (auth-service). */
  readonly authUpstreamUrl: string
  /**
   * Dev-only: when set, non-API requests are proxied to the Vite dev server
   * instead of being served from the built `dist/`. This lets the BFF sit in
   * front of Vite locally so every `/api/*` call exercises the routing table
   * (ADR 0017). Unset in production.
   */
  readonly viteDevServerUrl: string | null
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) {
    throw new Error(`stride-web BFF: required env ${name} is not set`)
  }
  return value
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BffConfig {
  const pythonApiUrl = stripTrailingSlash(requireEnv(env, 'PYTHON_API_URL'))
  const authUpstreamUrl = stripTrailingSlash(requireEnv(env, 'AUTH_UPSTREAM_URL'))
  const goRaw = env.GO_API_URL?.trim()
  const goApiUrl = goRaw ? stripTrailingSlash(goRaw) : null

  const portRaw = env.PORT?.trim() ?? '8080'
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`stride-web BFF: invalid PORT ${JSON.stringify(portRaw)}`)
  }

  const devRaw = env.VITE_DEV_SERVER_URL?.trim()
  const viteDevServerUrl = devRaw ? stripTrailingSlash(devRaw) : null

  return { port, pythonApiUrl, goApiUrl, authUpstreamUrl, viteDevServerUrl }
}
