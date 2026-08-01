import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'

import { loadConfig } from './config.js'
import { proxyToUpstream } from './proxy.js'
import { hasGoRoutes, resolveUpstream } from './routing/table.js'
import { baseUrlFor } from './routing/upstreams.js'

const config = loadConfig()

// Fail fast: a manifest that routes any endpoint to Go with no GO_API_URL would
// 502 every cutover endpoint at runtime — catch it at boot instead.
if (hasGoRoutes() && !config.goApiUrl) {
  throw new Error('stride-web BFF: an API route is set to Go but GO_API_URL is not set')
}

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
  // Prod: serve the built SPA. Content-hashed files under /assets get an
  // immutable policy; everything else stays revalidated.
  const indexHtml = readFileSync(join(STATIC_ROOT, 'index.html'), 'utf-8')
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
  app.get('*', (c) => {
    c.header('Cache-Control', 'no-cache')
    return c.html(indexHtml)
  })
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `stride-web BFF listening on :${info.port} ` +
      `(python=${config.pythonApiUrl}, go=${config.goApiUrl ?? '(unset)'}, auth=${config.authUpstreamUrl})`,
  )
})

export { app }
