import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'

import { loadConfig, type BffConfig } from './config.js'
import { proxyToUpstream } from './proxy.js'
import { API_ROUTES } from './routing/api-routes.js'
import { AUTH_PREFIX, resolveUpstream, upstreamForRoute } from './routing/table.js'
import { validateRouteConfiguration } from './routing/validation.js'
import { baseUrlFor } from './routing/upstreams.js'

const config = loadConfig()

/**
 * Build the routing config the BFF injects into index.html for the SPA. When
 * PUBLIC_DIRECT_BASE_URL is set, the browser sends Tencent-bound (auth + Go)
 * requests direct to that gateway; the manifest lets the client mirror the BFF's
 * resolveUpstream exactly. Empty → nothing injected beyond an empty base, so the
 * SPA stays relative/same-origin (dev + future co-located state).
 */
function routingConfigForClient(cfg: BffConfig): Record<string, unknown> {
  if (!cfg.publicDirectBaseUrl) return { directBaseUrl: '' }
  return {
    directBaseUrl: cfg.publicDirectBaseUrl,
    authPrefix: AUTH_PREFIX,
    routes: API_ROUTES.map((r) => ({ method: r.method, path: r.path, upstream: upstreamForRoute(r) })),
  }
}

function injectRouting(html: string, cfg: BffConfig): string {
  // Escape `<` so a path can never break out of the <script> element.
  const json = JSON.stringify(routingConfigForClient(cfg)).replace(/</g, '\\u003c')
  const tag = `<script>window.__STRIDE_ROUTING__=${json}</script>`
  return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : `${tag}${html}`
}

// Fail closed before accepting traffic: route flags, Go capability declarations,
// and the upstream URL must agree at startup.
validateRouteConfiguration(process.env, config.goApiUrl)

// Roots are relative to the process CWD (see Dockerfile.web WORKDIR).
const STATIC_ROOT = process.env.STATIC_DIR?.trim() || './dist'
const STRENGTH_ROOT = process.env.STRENGTH_DIR?.trim() || './strength_illustrations/output'

const app = new Hono()

// Liveness probe (Azure Container Apps ingress). Pure BFF liveness — does not
// depend on upstream reachability, so a slow upstream can't flap the replica.
app.get('/healthz', (c) => c.json({ status: 'ok' }))

// The single API seam: every browser /api/* call is proxied to one upstream
// chosen by the versioned routing table (auth / go / python).
app.all('/api/*', async (c) => {
  const upstream = resolveUpstream(c.req.method, c.req.path)
  let base: string
  try {
    base = baseUrlFor(upstream, config)
  } catch {
    return c.json({ detail: 'upstream_not_configured' }, 502)
  }
  return proxyToUpstream(c.req.raw, base)
})

// Strength illustration library — moved into the web image (ADR 0017). The
// Python/Go API returns relative `/strength_illustrations/output/...` URLs; the
// browser fetches them here, same-origin.
app.use(
  '/strength_illustrations/output/*',
  serveStatic({
    root: STRENGTH_ROOT,
    rewriteRequestPath: (path) => path.replace(/^\/strength_illustrations\/output/, ''),
    onFound: (_path, c) => {
      c.header('Cache-Control', 'public, max-age=86400')
    },
  }),
)

if (config.viteDevServerUrl) {
  // Dev: the BFF fronts the Vite dev server. Everything that isn't /api or a
  // strength asset is proxied to Vite (HTML + modules). The Vite HMR websocket
  // is configured (VITE_HMR_CLIENT_PORT) to connect straight to Vite, bypassing
  // the BFF, so no websocket proxying is needed here.
  const devTarget = config.viteDevServerUrl
  console.log(`[dev] proxying non-API requests to Vite at ${devTarget}`)
  app.all('*', (c) => proxyToUpstream(c.req.raw, devTarget))
} else {
  // Prod: serve the built SPA. index.html is served with the routing config
  // injected (window.__STRIDE_ROUTING__). serveStatic would otherwise serve the
  // RAW index.html for `/`, so we intercept `/` (and the SPA fallback) with the
  // injected copy; serveStatic only handles hashed assets / static files.
  const indexHtml = injectRouting(readFileSync(join(STATIC_ROOT, 'index.html'), 'utf-8'), config)
  const serveIndex = (c: Context) => {
    c.header('Cache-Control', 'no-cache')
    return c.html(indexHtml)
  }

  // Root must be served with injection BEFORE serveStatic (which would serve the
  // raw index.html for a directory request).
  app.get('/', serveIndex)

  app.use(
    '/*',
    serveStatic({
      root: STATIC_ROOT,
      onFound: (path, c) => {
        if (path.includes('/assets/')) {
          c.header('Cache-Control', 'public, max-age=31536000, immutable')
        }
      },
    }),
  )
  // SPA fallback — must be last so it never shadows /api or static files.
  app.get('*', serveIndex)
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `stride-web BFF listening on :${info.port} ` +
      `(python=${config.pythonApiUrl}, go=${config.goApiUrl ?? '(unset)'}, auth=${config.authUpstreamUrl})`,
  )
})

export { app }
