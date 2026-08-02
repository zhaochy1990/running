/**
 * API migration manifest — the source of truth for the Python→Go strangler.
 *
 * One entry per backend `/api/*` endpoint (method + path). `resolveUpstream`
 * (routing/table.ts) matches the incoming request against this list and proxies
 * it to `upstream`. Default/unlisted → Python. `/api/auth/*` is handled
 * separately (always the auth-service) and is NOT listed here.
 *
 * TO MIGRATE ONE ENDPOINT TO GO:
 *   1. Confirm `goReady: true` (the Go API implements this exact method+path).
 *   2. Make the matching frontend contract change if noted (e.g. watch_ready).
 *   3. Flip that entry's `upstream: 'python'` → `'go'`.
 *   4. Ensure `GO_API_URL` is set on stride-web (the BFF fails fast at boot if
 *      any entry is `'go'` but GO_API_URL is unset).
 *
 * `path` patterns: a `:seg` token matches exactly one path segment (the `{user}`
 * UUID, `{team_id}`, etc.). Matching is method-aware and most-specific-wins.
 *
 * Comment legend (stride-web frontend usage):
 *   ✓ = called by the frontend    ✗ = not called by any non-test frontend file
 *   [go-ready] = the Go API already implements this exact method+path
 * "global(layout)" = fired from shared chrome (TopNav / MessageCenter /
 * SyncStatusPill / app-boot profile gate), i.e. on effectively every page.
 * (Usage traced from frontend/src/api.ts call sites → AppRoutes.tsx pages.)
 */

export type RouteUpstream = 'python' | 'go'
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface ApiRoute {
  readonly method: HttpMethod
  /** Path pattern under /api; `:seg` matches one segment. */
  readonly path: string
  /** Where this endpoint is currently served. Flip to 'go' to cut it over. */
  readonly upstream: RouteUpstream
  /** True when the Go API implements this exact method+path (cutover candidate). */
  readonly goReady: boolean
}

export const API_ROUTES: readonly ApiRoute[] = [
  // ── Liveness / users list ───────────────────────────────────────────────
  // ✗ BFF has its own /healthz; this proxies to Python's health.
  { method: 'GET', path: '/api/health', upstream: 'python', goReady: false },
  // ✗ wrapper (getUsers) exists but only exercised in tests.
  { method: 'GET', path: '/api/users', upstream: 'python', goReady: false },

  // ── Profile & account (users/me) ────────────────────────────────────────
  // ✓ global(layout) · load profile on app boot / onboarding gate   [go-ready]
  //   Go note: returns watch_ready (not coros_ready) — frontend rename gates cutover.
  { method: 'GET', path: '/api/users/me/profile', upstream: 'python', goReady: true },
  // ✓ /onboarding · submit basic profile   [go-ready] (same watch_ready caveat)
  { method: 'POST', path: '/api/users/me/profile', upstream: 'python', goReady: true },
  // ✓ /settings · edit profile fields   (Go has no PATCH profile yet)
  { method: 'PATCH', path: '/api/users/me/profile', upstream: 'python', goReady: false },
  // ✓ /settings · delete account
  { method: 'DELETE', path: '/api/users/me', upstream: 'python', goReady: false },
  // ✓ /settings + global(layout) · watch info + sync pill state   [ON GO]
  //   Reverted to Python (BFF-relative → Azure) after the Go cutover surfaced a
  //   cross-store gap: disconnect (DELETE) writes only Tencent MySQL while connect
  //   still runs through Python/Azure (coros/garmin login below), so the two
  //   credential stores drift. goReady stays true — Go implements both method+paths;
  //   re-flip upstream to 'go' once connect is on Go and the stores are reconciled.
  { method: 'GET', path: '/api/users/me/watch', upstream: 'python', goReady: true },
  // ✓ /settings · disconnect watch
  { method: 'DELETE', path: '/api/users/me/watch', upstream: 'python', goReady: true },
  // ✓ /onboarding, /settings · connect COROS account
  //   Go note: Go unifies these as POST /api/users/me/watch/login {provider} —
  //   cutover needs the frontend to switch to the unified path.
  { method: 'POST', path: '/api/users/me/coros/login', upstream: 'python', goReady: false },
  // ✓ /onboarding, /settings · connect Garmin account (same unified-login note)
  { method: 'POST', path: '/api/users/me/garmin/login', upstream: 'python', goReady: false },

  // ── Onboarding & sync ───────────────────────────────────────────────────
  // ✗ not called (frontend polls /sync-status instead)
  { method: 'GET', path: '/api/users/me/onboarding/pipeline-status', upstream: 'python', goReady: false },
  // ✓ /onboarding · finalize onboarding, kick off first sync
  { method: 'POST', path: '/api/users/me/onboarding/complete', upstream: 'python', goReady: false },
  // ✓ /onboarding · poll onboarding sync status
  { method: 'GET', path: '/api/users/me/sync-status', upstream: 'python', goReady: false },
  // ✓ /plan · poll full-history-sync progress during plan setup
  { method: 'GET', path: '/api/users/me/full-sync-status', upstream: 'python', goReady: false },
  // ✓ /plan · trigger full history sync
  { method: 'POST', path: '/api/users/me/full-sync', upstream: 'python', goReady: false },
  // ✓ global(layout) · manual sync from the sync pill
  //   Go note: starts an async data-sync pipeline (sync + compute) and returns
  //   202 {run_id} to poll GET /pipelines/:id (ADR 0020), vs Python's
  //   synchronous {success,output}. Cutover needs the pill to poll — not just routing.
  { method: 'POST', path: '/api/:user/sync', upstream: 'python', goReady: true },

  // ── Training goal / running profile / prefs ─────────────────────────────
  // TrainingPlanPage.tsx:207
  // 在创建训练计划的时候需要获取用户的目标
  // ✓ /plan · load current training goal
  { method: 'GET', path: '/api/users/me/training-goal', upstream: 'python', goReady: false },
  // ✓ /plan · create race training goal
  { method: 'POST', path: '/api/users/me/training-goal', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'PUT', path: '/api/users/me/training-goal', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/users/me/running-profile', upstream: 'python', goReady: false },
  // ✓ /plan · create running profile during setup
  { method: 'POST', path: '/api/users/me/running-profile', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'PUT', path: '/api/users/me/running-profile', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/users/me/nutrition-prefs', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'PUT', path: '/api/users/me/nutrition-prefs', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/users/me/notification-prefs', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'PATCH', path: '/api/users/me/notification-prefs', upstream: 'python', goReady: false },

  // ── Notifications & push devices ────────────────────────────────────────
  // ✓ global(layout) · message-center notifications list
  { method: 'GET', path: '/api/users/me/notifications', upstream: 'python', goReady: false },
  // ✓ global(layout) · notifications read state (unread badge)
  { method: 'GET', path: '/api/users/me/notifications/read-state', upstream: 'python', goReady: false },
  // ✓ global(layout) · mark a notification read
  { method: 'POST', path: '/api/users/me/notifications/:notificationId/read', upstream: 'python', goReady: false },
  // ✗ not called (push registration not wired in web)
  { method: 'POST', path: '/api/users/me/devices', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'DELETE', path: '/api/users/me/devices/:registrationId', upstream: 'python', goReady: false },

  // ── Master plan (season plan) ───────────────────────────────────────────
  // ✓ /plan, /plan/adjust · load active season plan
  { method: 'GET', path: '/api/users/me/master-plan/current', upstream: 'python', goReady: false },
  // ✓ /plan · load draft season plan (404 = no draft, expected)
  { method: 'GET', path: '/api/users/me/master-plan/draft', upstream: 'python', goReady: false },
  // ✓ /plan, /coach/master/:planId/adjust · load plan by id
  { method: 'GET', path: '/api/users/me/master-plan/:planId', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/users/me/master-plan/:planId/versions', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/users/me/master-plan/:planId/versions/:versionNumber', upstream: 'python', goReady: false },
  // ✓ /plan · poll season-plan generation job
  { method: 'GET', path: '/api/users/me/master-plan/jobs/:jobId', upstream: 'python', goReady: false },
  // ✓ /plan · start season-plan generation
  { method: 'POST', path: '/api/users/me/master-plan/generate', upstream: 'python', goReady: false },
  // ✓ /plan · review-chat message on the draft
  { method: 'POST', path: '/api/users/me/master-plan/:planId/review/messages', upstream: 'python', goReady: false },
  // ✓ /plan · apply reviewed diff to the draft
  { method: 'POST', path: '/api/users/me/master-plan/:planId/review/apply', upstream: 'python', goReady: false },
  // ✓ /plan · promote draft to active
  { method: 'POST', path: '/api/users/me/master-plan/:planId/confirm', upstream: 'python', goReady: false },
  // ✓ /plan/adjust · adjust-chat message
  { method: 'POST', path: '/api/users/me/master-plan/:planId/adjust/messages', upstream: 'python', goReady: false },
  // ✓ /plan/adjust · apply adjustment diff
  { method: 'POST', path: '/api/users/me/master-plan/:planId/adjust/apply', upstream: 'python', goReady: false },

  // ── Coach ───────────────────────────────────────────────────────────────
  // ✓ /coach + /coach/*/adjust · send a coach chat turn
  { method: 'POST', path: '/api/users/me/coach/chat', upstream: 'python', goReady: false },
  // ✓ /coach/week/:folder/adjust · apply weekly coach proposal
  { method: 'POST', path: '/api/users/me/coach/plan/:folder/apply', upstream: 'python', goReady: false },
  // ✓ /coach/master/:planId/adjust · apply master coach proposal
  { method: 'POST', path: '/api/users/me/coach/master-plan/:planId/apply', upstream: 'python', goReady: false },
  // ✓ coach adjust pages · record an abandoned proposal
  { method: 'POST', path: '/api/users/me/coach/proposals/abandon', upstream: 'python', goReady: false },
  // ✓ /coach + adjust pages · load coach chat history
  { method: 'GET', path: '/api/users/me/coach/sessions/:sessionId/messages', upstream: 'python', goReady: false },

  // ── Activities (per-user, {user} = UUID) ────────────────────────────────
  // ✗ not called
  { method: 'GET', path: '/api/:user/home', upstream: 'python', goReady: false },
  // ✓ /activities, /plan/adjust, /training-status · list / paginate activities   [go-ready]
  //   Go note (ADR 0019): contract parity incl. monthly_summaries; safe to cut over.
  { method: 'GET', path: '/api/:user/activities', upstream: 'python', goReady: true },
  // ✓ /activity/:id · activity detail (?include=timeseries)   [go-ready]
  //   Go note (ADR 0019): zones projected from activity_watch_zones (watch-reported),
  //   not calibrated zones; linked_scheduled_workout always null — cutover gated on that gap.
  { method: 'GET', path: '/api/:user/activities/:labelId', upstream: 'python', goReady: true },
  // ✗ not called (detail uses ?include=timeseries instead)
  { method: 'GET', path: '/api/:user/activities/:labelId/timeseries', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/:user/activities/:labelId/feedback', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'PUT', path: '/api/:user/activities/:labelId/feedback', upstream: 'python', goReady: false },
  // ✓ /activity/:id · ability-contribution card
  { method: 'GET', path: '/api/:user/activities/:labelId/ability', upstream: 'python', goReady: false },
  // ✓ /activity/:id · resync this activity from the watch
  { method: 'POST', path: '/api/:user/activities/:labelId/resync', upstream: 'python', goReady: false },
  // ✗ not called (only .../commentary/regenerate is used)
  { method: 'POST', path: '/api/:user/activities/:labelId/commentary', upstream: 'python', goReady: false },
  // ✓ /activity/:id · regenerate AI commentary
  { method: 'POST', path: '/api/:user/activities/:labelId/commentary/regenerate', upstream: 'python', goReady: false },

  // ── Weeks / weekly plan.md ──────────────────────────────────────────────
  // ✓ /, /week, /plan, /plan/adjust · list weekly-plan folders
  { method: 'GET', path: '/api/:user/weeks', upstream: 'python', goReady: false },
  // ✓ /, /week, /coach/week/:folder/adjust · load week detail
  { method: 'GET', path: '/api/:user/weeks/:folder', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'PUT', path: '/api/:user/weeks/:folder/plan', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/:user/weeks/:folder/review', upstream: 'python', goReady: false },
  // ✓ /, /week, /coach/week · weekly strength tab
  { method: 'GET', path: '/api/:user/weeks/:folder/strength', upstream: 'python', goReady: false },
  // ✓ /, /week, /coach/week · save weekly feedback
  { method: 'PUT', path: '/api/:user/weeks/:folder/feedback', upstream: 'python', goReady: false },
  // ✓ /, /week · reparse plan.md into structured plan (WeekLayout)
  { method: 'POST', path: '/api/:user/plan/reparse', upstream: 'python', goReady: false },

  // ── Health / fitness / training-status ──────────────────────────────────
  // ✗ not called
  { method: 'GET', path: '/api/:user/dashboard', upstream: 'python', goReady: false },
  // ✓ /health, /training-status, /plan/adjust · RHR / health records
  { method: 'GET', path: '/api/:user/health', upstream: 'python', goReady: false },
  // ✓ /health, /plan/adjust · PMC / training-load curve
  { method: 'GET', path: '/api/:user/pmc', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/:user/stats', upstream: 'python', goReady: false },
  // ✓ /health, /training-status, /plan/adjust · HRV daily records
  { method: 'GET', path: '/api/:user/hrv', upstream: 'python', goReady: false },
  // ✓ /plan, /plan/adjust · training-plan phases / content
  { method: 'GET', path: '/api/:user/training-plan', upstream: 'python', goReady: false },
  // ✓ /training-status · STRIDE training-load series
  { method: 'GET', path: '/api/:user/stride/training-load', upstream: 'python', goReady: false },
  // ✓ /training-status, /plan/adjust · pace / HR zones
  { method: 'GET', path: '/api/:user/stride/zones', upstream: 'python', goReady: false },

  // ── Body composition ────────────────────────────────────────────────────
  // ✓ /body-composition · scans list
  { method: 'GET', path: '/api/:user/body-composition', upstream: 'python', goReady: false },
  // ✗ wrapper (getBodyCompositionScan) exists, no non-test caller
  { method: 'GET', path: '/api/:user/body-composition/:scanDate', upstream: 'python', goReady: false },
  // ✓ /body-composition · summary + deltas
  { method: 'GET', path: '/api/:user/body-composition/summary', upstream: 'python', goReady: false },
  // ✓ /body-composition · add / edit a body scan
  { method: 'POST', path: '/api/:user/body-composition', upstream: 'python', goReady: false },

  // ── Ability / PBs / race predictions ────────────────────────────────────
  // ✓ /ability · current ability snapshot
  { method: 'GET', path: '/api/:user/ability/current', upstream: 'python', goReady: false },
  // ✓ /ability · ability history chart
  { method: 'GET', path: '/api/:user/ability/history', upstream: 'python', goReady: false },
  // ✓ /ability · ability layer weights
  { method: 'GET', path: '/api/:user/ability/weights', upstream: 'python', goReady: false },
  // ✓ /ability · backfill ability history
  { method: 'POST', path: '/api/:user/ability/backfill', upstream: 'python', goReady: false },
  // ✓ /ability · personal bests
  { method: 'GET', path: '/api/:user/pbs', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/:user/race-predictions', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/:user/race-predictions/history', upstream: 'python', goReady: false },

  // ── Nutrition ───────────────────────────────────────────────────────────
  // ✗ not called
  { method: 'GET', path: '/api/:user/nutrition/meals', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'POST', path: '/api/:user/nutrition/meals', upstream: 'python', goReady: false },

  // ── Plan variants / scheduled sessions ──────────────────────────────────
  // ✗ wrapper (getPlanToday) exists, no non-test caller
  { method: 'GET', path: '/api/:user/plan/today', upstream: 'python', goReady: false },
  // ✓ /, /week, /coach/week, /plan/adjust · planned-vs-actual calendar
  { method: 'GET', path: '/api/:user/plan/days', upstream: 'python', goReady: false },
  // ✓ /, /week · multi-variant comparison
  { method: 'GET', path: '/api/:user/plan/:folder/variants', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'POST', path: '/api/:user/plan/:folder/variants', upstream: 'python', goReady: false },
  // ✗ wrapper (deletePlanVariants) exists, no non-test caller
  { method: 'DELETE', path: '/api/:user/plan/:folder/variants', upstream: 'python', goReady: false },
  // ✓ /, /week · rate a plan variant
  { method: 'POST', path: '/api/:user/plan/variants/:variantId/rate', upstream: 'python', goReady: false },
  // ✓ /, /week · select the canonical variant
  { method: 'POST', path: '/api/:user/plan/:folder/select', upstream: 'python', goReady: false },
  // ✗ not called (session-level push is used instead)
  { method: 'POST', path: '/api/:user/plan/:folder/push', upstream: 'python', goReady: false },
  // ✓ /, /week, /coach/week · push a planned session to the watch
  { method: 'POST', path: '/api/:user/plan/sessions/:date/:sessionIndex/push', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'POST', path: '/api/:user/plan/weeks/generate', upstream: 'python', goReady: false },
  // ✗ not called
  { method: 'POST', path: '/api/:user/workout/run', upstream: 'python', goReady: false },

  // ── Teams & social ──────────────────────────────────────────────────────
  // ✓ /teams, /teams/:id · my team memberships
  { method: 'GET', path: '/api/users/me/teams', upstream: 'python', goReady: false },
  // ✓ /teams · list all teams
  { method: 'GET', path: '/api/teams', upstream: 'python', goReady: false },
  // ✓ /teams/new · create a team
  { method: 'POST', path: '/api/teams', upstream: 'python', goReady: false },
  // ✓ /teams/:id · team detail
  { method: 'GET', path: '/api/teams/:teamId', upstream: 'python', goReady: false },
  // ✓ /teams/:id · delete team
  { method: 'DELETE', path: '/api/teams/:teamId', upstream: 'python', goReady: false },
  // ✓ /teams/:id · team member list
  { method: 'GET', path: '/api/teams/:teamId/members', upstream: 'python', goReady: false },
  // ✓ /teams/:id · team activity feed
  { method: 'GET', path: '/api/teams/:teamId/feed', upstream: 'python', goReady: false },
  // ✓ /teams/:id · mileage leaderboard
  { method: 'GET', path: '/api/teams/:teamId/mileage', upstream: 'python', goReady: false },
  // ✓ /teams, /teams/:id · join team
  { method: 'POST', path: '/api/teams/:teamId/join', upstream: 'python', goReady: false },
  // ✓ /teams/:id · leave team
  { method: 'POST', path: '/api/teams/:teamId/leave', upstream: 'python', goReady: false },
  // ✓ /teams/:id · sync all members
  { method: 'POST', path: '/api/teams/:teamId/sync-all', upstream: 'python', goReady: false },
  // ✓ /teams/:id · transfer ownership
  { method: 'POST', path: '/api/teams/:teamId/transfer-owner', upstream: 'python', goReady: false },
  // ✓ /activity/:id (team view) · load a teammate's activity detail
  { method: 'GET', path: '/api/teams/:teamId/activities/:userId/:labelId', upstream: 'python', goReady: false },
  // ✓ /teams/:id · activity like list
  { method: 'GET', path: '/api/teams/:teamId/activities/:userId/:labelId/likes', upstream: 'python', goReady: false },
  // ✓ /teams/:id · like an activity
  { method: 'POST', path: '/api/teams/:teamId/activities/:userId/:labelId/likes', upstream: 'python', goReady: false },
  // ✓ /teams/:id · unlike an activity
  { method: 'DELETE', path: '/api/teams/:teamId/activities/:userId/:labelId/likes', upstream: 'python', goReady: false },
]
