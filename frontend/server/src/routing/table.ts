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

import { API_ROUTES, type ApiRoute } from "./api-routes.js";

export type Upstream = "python" | "go" | "auth";

/**
 * Web onboarding is a single Go contract: read and persist profile readiness,
 * connect the Go-owned watch credential, start generic full sync, poll that run,
 * then explicitly finalize it. Routing only a subset would mix the legacy Python
 * state with the Go run_id lifecycle.
 */
export const WEB_ONBOARDING_GO_ROUTE_ENVS = [
  "STRIDE_ROUTE_GET_USERS_ME_PROFILE",
  "STRIDE_ROUTE_POST_USERS_ME_PROFILE",
  "STRIDE_ROUTE_PATCH_USERS_ME_PROFILE",
  "STRIDE_ROUTE_POST_USERS_ME_WATCH_LOGIN",
  "STRIDE_ROUTE_GET_USERS_ME_INJURIES",
  "STRIDE_ROUTE_POST_USERS_ME_INJURIES",
  "STRIDE_ROUTE_PUT_USERS_ME_INJURIES_INJURYID",
  "STRIDE_ROUTE_DELETE_USERS_ME_INJURIES_INJURYID",
  "STRIDE_ROUTE_POST_USER_SYNC",
  "STRIDE_ROUTE_GET_PIPELINES_RUNID",
  "STRIDE_ROUTE_GET_JOBS_JOBID",
  "STRIDE_ROUTE_POST_USERS_ME_ONBOARDING_COMPLETE",
] as const;

export const WEB_ONBOARDING_GO_ROUTE_CONTRACT = [
  { method: "GET", path: "/api/users/me/profile", env: "STRIDE_ROUTE_GET_USERS_ME_PROFILE" },
  { method: "POST", path: "/api/users/me/profile", env: "STRIDE_ROUTE_POST_USERS_ME_PROFILE" },
  { method: "PATCH", path: "/api/users/me/profile", env: "STRIDE_ROUTE_PATCH_USERS_ME_PROFILE" },
  { method: "POST", path: "/api/users/me/watch/login", env: "STRIDE_ROUTE_POST_USERS_ME_WATCH_LOGIN" },
  { method: "GET", path: "/api/users/me/injuries", env: "STRIDE_ROUTE_GET_USERS_ME_INJURIES" },
  { method: "POST", path: "/api/users/me/injuries", env: "STRIDE_ROUTE_POST_USERS_ME_INJURIES" },
  { method: "PUT", path: "/api/users/me/injuries/:injuryId", env: "STRIDE_ROUTE_PUT_USERS_ME_INJURIES_INJURYID" },
  { method: "DELETE", path: "/api/users/me/injuries/:injuryId", env: "STRIDE_ROUTE_DELETE_USERS_ME_INJURIES_INJURYID" },
  { method: "POST", path: "/api/:user/sync", env: "STRIDE_ROUTE_POST_USER_SYNC" },
  { method: "GET", path: "/api/pipelines/:run_id", env: "STRIDE_ROUTE_GET_PIPELINES_RUNID" },
  { method: "GET", path: "/api/jobs/:job_id", env: "STRIDE_ROUTE_GET_JOBS_JOBID" },
  { method: "POST", path: "/api/users/me/onboarding/complete", env: "STRIDE_ROUTE_POST_USERS_ME_ONBOARDING_COMPLETE" },
] as const;

/** Routes whose Go cutover must include both goal methods and the shared sync path. */
export const PLAN_SETUP_GO_ROUTE_ENVS = [
  "STRIDE_ROUTE_GET_USERS_ME_TRAINING_GOAL",
  "STRIDE_ROUTE_POST_USERS_ME_TRAINING_GOAL",
  "STRIDE_ROUTE_POST_USER_SYNC",
  "STRIDE_ROUTE_GET_PIPELINES_RUNID",
] as const;

export const PLAN_SETUP_GO_ROUTE_CONTRACT = [
  { method: "GET", path: "/api/users/me/training-goal", env: "STRIDE_ROUTE_GET_USERS_ME_TRAINING_GOAL" },
  { method: "POST", path: "/api/users/me/training-goal", env: "STRIDE_ROUTE_POST_USERS_ME_TRAINING_GOAL" },
  { method: "POST", path: "/api/:user/sync", env: "STRIDE_ROUTE_POST_USER_SYNC" },
  { method: "GET", path: "/api/pipelines/:run_id", env: "STRIDE_ROUTE_GET_PIPELINES_RUNID" },
] as const;

/** Weekly feedback can move only when both aggregate readers already use Go. */
export const WEEKLY_FEEDBACK_GO_ROUTE_ENVS = [
  "STRIDE_ROUTE_GET_USER_WEEKS",
  "STRIDE_ROUTE_GET_USER_WEEKS_WEEKNAME",
  "STRIDE_ROUTE_PUT_USER_WEEKS_WEEKNAME_FEEDBACK",
] as const;

/** Body composition routes are cut over atomically — all four or none. */
export const BODY_COMPOSITION_GO_ROUTE_ENVS = [
  "STRIDE_ROUTE_GET_USER_BODY_COMPOSITION",
  "STRIDE_ROUTE_GET_USER_BODY_COMPOSITION_SCANDATE",
  "STRIDE_ROUTE_GET_USER_BODY_COMPOSITION_SUMMARY",
  "STRIDE_ROUTE_POST_USER_BODY_COMPOSITION",
] as const;

export const BODY_COMPOSITION_GO_ROUTE_CONTRACT = [
  { method: "GET", path: "/api/:user/body-composition", env: "STRIDE_ROUTE_GET_USER_BODY_COMPOSITION" },
  { method: "GET", path: "/api/:user/body-composition/:scanDate", env: "STRIDE_ROUTE_GET_USER_BODY_COMPOSITION_SCANDATE" },
  { method: "GET", path: "/api/:user/body-composition/summary", env: "STRIDE_ROUTE_GET_USER_BODY_COMPOSITION_SUMMARY" },
  { method: "POST", path: "/api/:user/body-composition", env: "STRIDE_ROUTE_POST_USER_BODY_COMPOSITION" },
] as const;

/** Prefix under which the in-house auth-service is reached (same-origin via BFF). */
export const AUTH_PREFIX = "/api/auth";

/** Env value (case-insensitive) that opts an endpoint into the Go upstream. */
const GO_ENV_VALUE = "go";

function segments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true;
  const boundary = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return pathname.startsWith(boundary);
}

/**
 * Score a path against a manifest pattern. Returns the count of literal segments
 * matched (higher = more specific), or -1 when it does not match. A `:seg` token
 * matches any single segment; segment counts must be equal.
 */
function matchScore(pathSegs: string[], pattern: string): number {
  const patSegs = segments(pattern);
  if (patSegs.length !== pathSegs.length) return -1;
  let literals = 0;
  for (let i = 0; i < patSegs.length; i++) {
    if (patSegs[i].startsWith(":")) continue;
    if (patSegs[i] !== pathSegs[i]) return -1;
    literals++;
  }
  return literals;
}

/**
 * The upstream a single manifest entry currently resolves to, per its env var.
 * `go` only when the variable is set to `go` (case-insensitive, trimmed);
 * otherwise `python` (the safe default — unset/empty/any other value).
 */
export function upstreamForRoute(route: ApiRoute, env: NodeJS.ProcessEnv = process.env): "python" | "go" {
  return env[route.env]?.trim().toLowerCase() === GO_ENV_VALUE ? "go" : "python";
}

/**
 * Resolve which upstream a request goes to. `/api/auth/*` → auth; otherwise the
 * best-matching manifest entry's env-selected upstream; otherwise Python.
 */
export function resolveUpstream(method: string, pathname: string, env: NodeJS.ProcessEnv = process.env): Upstream {
  if (matchesPrefix(pathname, AUTH_PREFIX)) return "auth";

  const wantedMethod = method.toUpperCase();
  const pathSegs = segments(pathname);
  let bestScore = -1;
  let bestRoute: ApiRoute | null = null;
  for (const route of API_ROUTES) {
    if (route.method !== wantedMethod) continue;
    const score = matchScore(pathSegs, route.path);
    if (score > bestScore) {
      bestScore = score;
      bestRoute = route;
    }
  }
  return bestRoute ? upstreamForRoute(bestRoute, env) : "python";
}

/** True when any manifest entry's env var currently routes it to Go (used at
 *  boot to require GO_API_URL). */
export function hasGoRoutes(env: NodeJS.ProcessEnv = process.env): boolean {
  return API_ROUTES.some((route) => upstreamForRoute(route, env) === "go");
}

/** Return routes configured for Go that the Go API does not implement. */
export function unsupportedGoRoutes(env: NodeJS.ProcessEnv = process.env): readonly ApiRoute[] {
  return API_ROUTES.filter((route) => !route.goReady && upstreamForRoute(route, env) === "go");
}

/** Reject a partial Web onboarding cutover before the BFF accepts traffic. */
function hasPartialGoCutover(routeEnvs: readonly string[], env: NodeJS.ProcessEnv): boolean {
  const enabled = routeEnvs.filter((name) => env[name]?.trim().toLowerCase() === GO_ENV_VALUE);
  return enabled.length > 0 && enabled.length < routeEnvs.length;
}

export function hasPartialWebOnboardingGoCutover(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasPartialGoCutover(WEB_ONBOARDING_GO_ROUTE_ENVS, env);
}

export function hasPartialPlanSetupGoCutover(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasPartialGoCutover(PLAN_SETUP_GO_ROUTE_ENVS, env);
}

export function hasPartialWeeklyFeedbackGoCutover(env: NodeJS.ProcessEnv = process.env): boolean {
  const putEnabled = env.STRIDE_ROUTE_PUT_USER_WEEKS_WEEKNAME_FEEDBACK?.trim().toLowerCase() === GO_ENV_VALUE;
  return putEnabled && hasPartialGoCutover(WEEKLY_FEEDBACK_GO_ROUTE_ENVS, env);
}

export function hasPartialBodyCompositionGoCutover(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasPartialGoCutover(BODY_COMPOSITION_GO_ROUTE_ENVS, env);
}
