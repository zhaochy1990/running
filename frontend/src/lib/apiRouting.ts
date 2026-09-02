/**
 * Client-side API base.
 *
 * Architecture: the frontend is a static container served from
 * `stride-running.cn`; Caddy is the single ingress that routes `/api/*` (and
 * `/api/auth/*`) to the backends at `api.stride-running.cn`. The browser
 * therefore calls the API gateway DIRECTLY (cross-origin; CORS must allow the
 * SPA origin `https://stride-running.cn`).
 *
 * The API origin is baked at build time via `VITE_API_BASE_URL`:
 *   - Production build sets it to `https://api.stride-running.cn` (Dockerfile.web).
 *   - Local dev leaves it empty → the SPA uses relative `/api/*` and the Vite dev
 *     proxy forwards them to the gateway server-side (no browser CORS).
 */

/**
 * Resolve the URL for a request. Returns the absolute API origin + path in
 * production; returns the path unchanged (relative) when no origin is baked in.
 */
export function apiUrl(_method: string, fullPath: string): string {
  const origin = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "").replace(/\/+$/, "");
  return origin ? `${origin}${fullPath}` : fullPath;
}
