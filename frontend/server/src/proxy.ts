/**
 * Transparent HTTP reverse proxy from the BFF to a chosen upstream.
 *
 * Forwards method, path, query, headers and body unchanged (Authorization,
 * X-Client-Id, Content-Type all pass through), so the token model is untouched.
 * Hop-by-hop headers are stripped per RFC 7230; the upstream Host is derived
 * from the target URL, not the browser's Host header.
 */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function sanitizeHeaders(source: Headers): Headers {
  const headers = new Headers(source)
  headers.delete('host')
  // Let fetch recompute framing for the (possibly re-encoded) forwarded body.
  headers.delete('content-length')
  for (const name of HOP_BY_HOP) headers.delete(name)
  return headers
}

/**
 * Proxy `request` to `baseUrl`, preserving pathname + query. `baseUrl` must be
 * an origin (e.g. `https://stride-app.example`); the incoming pathname is
 * resolved against it.
 */
export async function proxyToUpstream(request: Request, baseUrl: string): Promise<Response> {
  const incoming = new URL(request.url)
  const target = new URL(incoming.pathname + incoming.search, baseUrl)

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: sanitizeHeaders(request.headers),
    redirect: 'manual',
  }
  if (hasBody && request.body) {
    init.body = request.body
    // Required by Node's fetch when streaming a request body.
    init.duplex = 'half'
  }

  let upstream: Response
  try {
    upstream = await fetch(target, init)
  } catch {
    return new Response(JSON.stringify({ detail: 'upstream_unreachable' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
  }

  const responseHeaders = new Headers(upstream.headers)
  for (const name of HOP_BY_HOP) responseHeaders.delete(name)
  // Node's fetch transparently decodes gzip/br/deflate response bodies but
  // leaves the original Content-Encoding (and now-wrong Content-Length) headers
  // in place. Forwarding those with an already-decoded body makes the browser
  // try to decode plain bytes → ERR_CONTENT_DECODING_FAILED. Strip both so the
  // client receives the decoded body correctly (upstream e.g. FastAPI GZip).
  responseHeaders.delete('content-encoding')
  responseHeaders.delete('content-length')
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}
