/**
 * API migration manifest — the source of truth for the Python→Go strangler.
 *
 * One entry per backend `/api/*` endpoint (method + path). `resolveUpstream`
 * (routing/table.ts) matches the incoming request against this list and proxies
 * it to the resolved upstream. Default/unlisted → Python. `/api/auth/*` is
 * handled separately (always the auth-service) and is NOT listed here.
 *
 * PER-ENDPOINT ROUTING IS DRIVEN BY ENV VARS. Each entry declares an `env` name
 * (the `STRIDE_ROUTE_*` variable below). At request time the BFF reads that
 * variable: value `go` (case-insensitive, trimmed) → route this method+path to
 * the Go API; unset, empty, or any other value → keep it on Python. So the
 * manifest lists *which* env var controls each endpoint; the environment decides
 * *where* each endpoint is served — no code change / redeploy of this file needed
 * to cut one over.
 *
 * TO MIGRATE ONE ENDPOINT TO GO:
 *   1. Confirm `goReady: true` (the Go API implements this exact method+path).
 *   2. Make the matching frontend contract change if noted (e.g. watch_ready).
 *   3. Set that entry's `env` variable to `go` in the deployment environment.
 *   4. Ensure `GO_API_URL` is also set on stride-web (the BFF fails fast at boot
 *      if any entry's env var is `go` but GO_API_URL is unset).
 *
 * `path` patterns: a `:seg` token matches exactly one path segment (the `{user}`
 * UUID, `{team_id}`, etc.). Matching is method-aware and most-specific-wins.
 *
 * `env` naming: `STRIDE_ROUTE_<METHOD>_<PATH>`, where the path (after `/api/`) is
 * upper-cased with `/`, `-`, and `:` collapsed to `_` (a `:seg` param becomes its
 * name upper-cased, e.g. `:user` → `USER`). Every entry's env name is unique
 * (enforced by tests). Names are explicit here so an operator reading this file
 * sees exactly which variable flips which endpoint.
 *
 * Comment legend (stride-web frontend usage):
 *   ✓ = called by the frontend    ✗ = not called by any non-test frontend file
 *   [go-ready] = the Go API already implements this exact method+path
 * "global(layout)" = fired from shared chrome (TopNav / MessageCenter /
 * SyncStatusPill / app-boot profile gate), i.e. on effectively every page.
 * (Usage traced from frontend/src/api.ts call sites → AppRoutes.tsx pages.)
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface ApiRoute {
  readonly method: HttpMethod
  /** Path pattern under /api; `:seg` matches one segment. */
  readonly path: string
  /**
   * Environment variable that selects this endpoint's upstream. Set it to `go`
   * (case-insensitive) to route this method+path to the Go API; unset/empty/any
   * other value keeps it on Python.
   */
  readonly env: string
  /** True when the Go API implements this exact method+path (cutover candidate). */
  readonly goReady: boolean
}

export const API_ROUTES: readonly ApiRoute[] = [
  // ── Liveness / users list ───────────────────────────────────────────────
  // ✗ BFF has its own /healthz; this proxies to Python's health.
  { method: 'GET', path: '/api/health', env: 'STRIDE_ROUTE_GET_HEALTH', goReady: false },
  // ✗ wrapper (getUsers) exists but only exercised in tests.
  { method: 'GET', path: '/api/users', env: 'STRIDE_ROUTE_GET_USERS', goReady: false },

  // ── Profile & account (users/me) ────────────────────────────────────────
  // ✓ global(layout) · load profile on app boot / onboarding gate   [go-ready]
  //   Go note: returns watch_ready (not coros_ready) — frontend rename gates cutover.
  { method: 'GET', path: '/api/users/me/profile', env: 'STRIDE_ROUTE_GET_USERS_ME_PROFILE', goReady: true },
  // ✓ /onboarding · submit basic profile   [go-ready] (same watch_ready caveat)
  { method: 'POST', path: '/api/users/me/profile', env: 'STRIDE_ROUTE_POST_USERS_ME_PROFILE', goReady: true },
  // ✓ /settings · edit profile fields   (Go has no PATCH profile yet)
  { method: 'PATCH', path: '/api/users/me/profile', env: 'STRIDE_ROUTE_PATCH_USERS_ME_PROFILE', goReady: false },
  // ✓ /settings · delete account
  { method: 'DELETE', path: '/api/users/me', env: 'STRIDE_ROUTE_DELETE_USERS_ME', goReady: false },
  // ✓ /settings + global(layout) · watch info + sync pill state   [ON GO]
  //   Reverted to Python (BFF-relative → Azure) after the Go cutover surfaced a
  //   cross-store gap: disconnect (DELETE) writes only Tencent MySQL while connect
  //   still runs through Python/Azure (coros/garmin login below), so the two
  //   credential stores drift. goReady stays true — Go implements both method+paths;
  //   re-set env to 'go' once connect is on Go and the stores are reconciled.
  { method: 'GET', path: '/api/users/me/watch', env: 'STRIDE_ROUTE_GET_USERS_ME_WATCH', goReady: true },
  // ✓ /settings · disconnect watch
  { method: 'DELETE', path: '/api/users/me/watch', env: 'STRIDE_ROUTE_DELETE_USERS_ME_WATCH', goReady: true },
  // ✓ /onboarding, /settings · connect COROS account
  //   Go note: Go unifies these as POST /api/users/me/watch/login {provider} —
  //   cutover needs the frontend to switch to the unified path.
  { method: 'POST', path: '/api/users/me/coros/login', env: 'STRIDE_ROUTE_POST_USERS_ME_COROS_LOGIN', goReady: false },
  // ✓ /onboarding, /settings · connect Garmin account (same unified-login note)
  { method: 'POST', path: '/api/users/me/garmin/login', env: 'STRIDE_ROUTE_POST_USERS_ME_GARMIN_LOGIN', goReady: false },

  // ── Onboarding & sync ───────────────────────────────────────────────────
  // ✗ not called (frontend polls /sync-status instead)
  { method: 'GET', path: '/api/users/me/onboarding/pipeline-status', env: 'STRIDE_ROUTE_GET_USERS_ME_ONBOARDING_PIPELINE_STATUS', goReady: false },
  // ✓ /onboarding · finalize onboarding, kick off first sync
  { method: 'POST', path: '/api/users/me/onboarding/complete', env: 'STRIDE_ROUTE_POST_USERS_ME_ONBOARDING_COMPLETE', goReady: false },
  // ✓ /onboarding · poll onboarding sync status
  { method: 'GET', path: '/api/users/me/sync-status', env: 'STRIDE_ROUTE_GET_USERS_ME_SYNC_STATUS', goReady: false },
  // ✓ /plan · poll full-history-sync progress during plan setup
  { method: 'GET', path: '/api/users/me/full-sync-status', env: 'STRIDE_ROUTE_GET_USERS_ME_FULL_SYNC_STATUS', goReady: false },
  // ✓ /plan · trigger full history sync
  { method: 'POST', path: '/api/users/me/full-sync', env: 'STRIDE_ROUTE_POST_USERS_ME_FULL_SYNC', goReady: false },
  // ✓ global(layout) · manual sync from the sync pill
  //   Go note: starts an async data-sync pipeline (sync + compute) and returns
  //   202 {run_id} to poll GET /pipelines/:id (ADR 0020), vs Python's
  //   synchronous {success,output}. Cutover needs the pill to poll — not just routing.
  { method: 'POST', path: '/api/:user/sync', env: 'STRIDE_ROUTE_POST_USER_SYNC', goReady: true },

  // ── Training goal / running profile / prefs ─────────────────────────────
  // TrainingPlanPage.tsx:207
  // 在创建训练计划的时候需要获取用户的目标
  // ✓ /plan · load current training goal   [go-ready]
  { method: 'GET', path: '/api/users/me/training-goal', env: 'STRIDE_ROUTE_GET_USERS_ME_TRAINING_GOAL', goReady: true },
  // ✓ /plan · create race training goal   [go-ready]
  { method: 'POST', path: '/api/users/me/training-goal', env: 'STRIDE_ROUTE_POST_USERS_ME_TRAINING_GOAL', goReady: true },
  // ✗ not called   [go-ready]
  { method: 'PUT', path: '/api/users/me/training-goal', env: 'STRIDE_ROUTE_PUT_USERS_ME_TRAINING_GOAL', goReady: true },
  // ✗ not called
  { method: 'GET', path: '/api/users/me/running-profile', env: 'STRIDE_ROUTE_GET_USERS_ME_RUNNING_PROFILE', goReady: false },
  // ✓ /plan · create running profile during setup
  { method: 'POST', path: '/api/users/me/running-profile', env: 'STRIDE_ROUTE_POST_USERS_ME_RUNNING_PROFILE', goReady: false },
  // ✗ not called
  { method: 'PUT', path: '/api/users/me/running-profile', env: 'STRIDE_ROUTE_PUT_USERS_ME_RUNNING_PROFILE', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/users/me/nutrition-prefs', env: 'STRIDE_ROUTE_GET_USERS_ME_NUTRITION_PREFS', goReady: false },
  // ✗ not called
  { method: 'PUT', path: '/api/users/me/nutrition-prefs', env: 'STRIDE_ROUTE_PUT_USERS_ME_NUTRITION_PREFS', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/users/me/notification-prefs', env: 'STRIDE_ROUTE_GET_USERS_ME_NOTIFICATION_PREFS', goReady: false },
  // ✗ not called
  { method: 'PATCH', path: '/api/users/me/notification-prefs', env: 'STRIDE_ROUTE_PATCH_USERS_ME_NOTIFICATION_PREFS', goReady: false },

  // ── Notifications & push devices ────────────────────────────────────────
  // ✓ global(layout) · message-center notifications list
  { method: 'GET', path: '/api/users/me/notifications', env: 'STRIDE_ROUTE_GET_USERS_ME_NOTIFICATIONS', goReady: false },
  // ✓ global(layout) · notifications read state (unread badge)
  { method: 'GET', path: '/api/users/me/notifications/read-state', env: 'STRIDE_ROUTE_GET_USERS_ME_NOTIFICATIONS_READ_STATE', goReady: false },
  // ✓ global(layout) · mark a notification read
  { method: 'POST', path: '/api/users/me/notifications/:notificationId/read', env: 'STRIDE_ROUTE_POST_USERS_ME_NOTIFICATIONS_NOTIFICATIONID_READ', goReady: false },
  // ✗ not called (push registration not wired in web)
  { method: 'POST', path: '/api/users/me/devices', env: 'STRIDE_ROUTE_POST_USERS_ME_DEVICES', goReady: false },
  // ✗ not called
  { method: 'DELETE', path: '/api/users/me/devices/:registrationId', env: 'STRIDE_ROUTE_DELETE_USERS_ME_DEVICES_REGISTRATIONID', goReady: false },

  // ── Master plan (season plan) ───────────────────────────────────────────
  // ✓ /plan, /plan/adjust · load active season plan
  { method: 'GET', path: '/api/users/me/master-plan/current', env: 'STRIDE_ROUTE_GET_USERS_ME_MASTER_PLAN_CURRENT', goReady: false },
  // ✓ /plan · load draft season plan (404 = no draft, expected)
  { method: 'GET', path: '/api/users/me/master-plan/draft', env: 'STRIDE_ROUTE_GET_USERS_ME_MASTER_PLAN_DRAFT', goReady: false },
  // ✓ /plan, /coach/master/:planId/adjust · load plan by id
  { method: 'GET', path: '/api/users/me/master-plan/:planId', env: 'STRIDE_ROUTE_GET_USERS_ME_MASTER_PLAN_PLANID', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/users/me/master-plan/:planId/versions', env: 'STRIDE_ROUTE_GET_USERS_ME_MASTER_PLAN_PLANID_VERSIONS', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/users/me/master-plan/:planId/versions/:versionNumber', env: 'STRIDE_ROUTE_GET_USERS_ME_MASTER_PLAN_PLANID_VERSIONS_VERSIONNUMBER', goReady: false },
  // ✓ /plan · poll season-plan generation job
  { method: 'GET', path: '/api/users/me/master-plan/jobs/:jobId', env: 'STRIDE_ROUTE_GET_USERS_ME_MASTER_PLAN_JOBS_JOBID', goReady: false },
  // ✓ /plan · start season-plan generation
  { method: 'POST', path: '/api/users/me/master-plan/generate', env: 'STRIDE_ROUTE_POST_USERS_ME_MASTER_PLAN_GENERATE', goReady: false },
  // ✓ /plan · review-chat message on the draft
  { method: 'POST', path: '/api/users/me/master-plan/:planId/review/messages', env: 'STRIDE_ROUTE_POST_USERS_ME_MASTER_PLAN_PLANID_REVIEW_MESSAGES', goReady: false },
  // ✓ /plan · apply reviewed diff to the draft
  { method: 'POST', path: '/api/users/me/master-plan/:planId/review/apply', env: 'STRIDE_ROUTE_POST_USERS_ME_MASTER_PLAN_PLANID_REVIEW_APPLY', goReady: false },
  // ✓ /plan · promote draft to active
  { method: 'POST', path: '/api/users/me/master-plan/:planId/confirm', env: 'STRIDE_ROUTE_POST_USERS_ME_MASTER_PLAN_PLANID_CONFIRM', goReady: false },
  // ✓ /plan/adjust · adjust-chat message
  { method: 'POST', path: '/api/users/me/master-plan/:planId/adjust/messages', env: 'STRIDE_ROUTE_POST_USERS_ME_MASTER_PLAN_PLANID_ADJUST_MESSAGES', goReady: false },
  // ✓ /plan/adjust · apply adjustment diff
  { method: 'POST', path: '/api/users/me/master-plan/:planId/adjust/apply', env: 'STRIDE_ROUTE_POST_USERS_ME_MASTER_PLAN_PLANID_ADJUST_APPLY', goReady: false },

  // ── Coach ───────────────────────────────────────────────────────────────
  // ✓ /coach + /coach/*/adjust · send a coach chat turn
  { method: 'POST', path: '/api/users/me/coach/chat', env: 'STRIDE_ROUTE_POST_USERS_ME_COACH_CHAT', goReady: false },
  // ✓ /coach/week/:folder/adjust · apply weekly coach proposal
  { method: 'POST', path: '/api/users/me/coach/plan/:folder/apply', env: 'STRIDE_ROUTE_POST_USERS_ME_COACH_PLAN_FOLDER_APPLY', goReady: false },
  // ✓ /coach/master/:planId/adjust · apply master coach proposal
  { method: 'POST', path: '/api/users/me/coach/master-plan/:planId/apply', env: 'STRIDE_ROUTE_POST_USERS_ME_COACH_MASTER_PLAN_PLANID_APPLY', goReady: false },
  // ✓ coach adjust pages · record an abandoned proposal
  { method: 'POST', path: '/api/users/me/coach/proposals/abandon', env: 'STRIDE_ROUTE_POST_USERS_ME_COACH_PROPOSALS_ABANDON', goReady: false },
  // ✓ /coach + adjust pages · load coach chat history
  { method: 'GET', path: '/api/users/me/coach/sessions/:sessionId/messages', env: 'STRIDE_ROUTE_GET_USERS_ME_COACH_SESSIONS_SESSIONID_MESSAGES', goReady: false },

  // ── Activities (per-user, {user} = UUID) ────────────────────────────────
  // ✗ not called
  { method: 'GET', path: '/api/:user/home', env: 'STRIDE_ROUTE_GET_USER_HOME', goReady: false },
  // ✓ /activities, /plan/adjust, /training-status · list / paginate activities   [go-ready]
  //   Go note (ADR 0019): contract parity incl. monthly_summaries; safe to cut over.
  { method: 'GET', path: '/api/:user/activities', env: 'STRIDE_ROUTE_GET_USER_ACTIVITIES', goReady: true },
  // ✓ /activity/:id · activity detail (?include=timeseries)   [go-ready]
  //   Go note (ADR 0019): zones projected from activity_watch_zones (watch-reported),
  //   not calibrated zones; linked_scheduled_workout always null — cutover gated on that gap.
  { method: 'GET', path: '/api/:user/activities/:labelId', env: 'STRIDE_ROUTE_GET_USER_ACTIVITIES_LABELID', goReady: true },
  // ✗ not called (detail uses ?include=timeseries instead)
  { method: 'GET', path: '/api/:user/activities/:labelId/timeseries', env: 'STRIDE_ROUTE_GET_USER_ACTIVITIES_LABELID_TIMESERIES', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/:user/activities/:labelId/feedback', env: 'STRIDE_ROUTE_GET_USER_ACTIVITIES_LABELID_FEEDBACK', goReady: false },
  // ✗ not called
  { method: 'PUT', path: '/api/:user/activities/:labelId/feedback', env: 'STRIDE_ROUTE_PUT_USER_ACTIVITIES_LABELID_FEEDBACK', goReady: false },
  // ✓ /activity/:id · ability-contribution card
  { method: 'GET', path: '/api/:user/activities/:labelId/ability', env: 'STRIDE_ROUTE_GET_USER_ACTIVITIES_LABELID_ABILITY', goReady: false },
  // ✓ /activity/:id · resync this activity from the watch
  { method: 'POST', path: '/api/:user/activities/:labelId/resync', env: 'STRIDE_ROUTE_POST_USER_ACTIVITIES_LABELID_RESYNC', goReady: false },
  // ✗ not called (only .../commentary/regenerate is used)
  { method: 'POST', path: '/api/:user/activities/:labelId/commentary', env: 'STRIDE_ROUTE_POST_USER_ACTIVITIES_LABELID_COMMENTARY', goReady: false },
  // ✓ /activity/:id · regenerate AI commentary
  { method: 'POST', path: '/api/:user/activities/:labelId/commentary/regenerate', env: 'STRIDE_ROUTE_POST_USER_ACTIVITIES_LABELID_COMMENTARY_REGENERATE', goReady: false },

  // ── Weeks / weekly plan.md ──────────────────────────────────────────────
  // ✓ /, /week, /plan, /plan/adjust · list weekly-plan folders
  { method: 'GET', path: '/api/:user/weeks', env: 'STRIDE_ROUTE_GET_USER_WEEKS', goReady: false },
  // ✓ /, /week, /coach/week/:folder/adjust · load week detail
  { method: 'GET', path: '/api/:user/weeks/:folder', env: 'STRIDE_ROUTE_GET_USER_WEEKS_FOLDER', goReady: false },
  // ✗ not called
  { method: 'PUT', path: '/api/:user/weeks/:folder/plan', env: 'STRIDE_ROUTE_PUT_USER_WEEKS_FOLDER_PLAN', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/:user/weeks/:folder/review', env: 'STRIDE_ROUTE_GET_USER_WEEKS_FOLDER_REVIEW', goReady: false },
  // ✓ /, /week, /coach/week · weekly strength tab
  { method: 'GET', path: '/api/:user/weeks/:folder/strength', env: 'STRIDE_ROUTE_GET_USER_WEEKS_FOLDER_STRENGTH', goReady: false },
  // ✓ /, /week, /coach/week · save weekly feedback
  { method: 'PUT', path: '/api/:user/weeks/:folder/feedback', env: 'STRIDE_ROUTE_PUT_USER_WEEKS_FOLDER_FEEDBACK', goReady: false },
  // ✓ /, /week · reparse plan.md into structured plan (WeekLayout)
  { method: 'POST', path: '/api/:user/plan/reparse', env: 'STRIDE_ROUTE_POST_USER_PLAN_REPARSE', goReady: false },

  // ── Health / fitness / training-status ──────────────────────────────────
  // ✗ not called
  { method: 'GET', path: '/api/:user/dashboard', env: 'STRIDE_ROUTE_GET_USER_DASHBOARD', goReady: false },
  // ✓ /health, /training-status, /plan/adjust · RHR / health records
  { method: 'GET', path: '/api/:user/health', env: 'STRIDE_ROUTE_GET_USER_HEALTH', goReady: false },
  // ✓ /health, /plan/adjust · PMC / training-load curve
  { method: 'GET', path: '/api/:user/pmc', env: 'STRIDE_ROUTE_GET_USER_PMC', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/:user/stats', env: 'STRIDE_ROUTE_GET_USER_STATS', goReady: false },
  // ✓ /health, /training-status, /plan/adjust · HRV daily records
  { method: 'GET', path: '/api/:user/hrv', env: 'STRIDE_ROUTE_GET_USER_HRV', goReady: false },
  // ✓ /plan, /plan/adjust · training-plan phases / content
  { method: 'GET', path: '/api/:user/training-plan', env: 'STRIDE_ROUTE_GET_USER_TRAINING_PLAN', goReady: false },
  // ✓ /training-status · STRIDE training-load series
  { method: 'GET', path: '/api/:user/stride/training-load', env: 'STRIDE_ROUTE_GET_USER_STRIDE_TRAINING_LOAD', goReady: false },
  // ✓ /training-status, /plan/adjust · pace / HR zones
  { method: 'GET', path: '/api/:user/stride/zones', env: 'STRIDE_ROUTE_GET_USER_STRIDE_ZONES', goReady: false },

  // ── Body composition ────────────────────────────────────────────────────
  // ✓ /body-composition · scans list
  { method: 'GET', path: '/api/:user/body-composition', env: 'STRIDE_ROUTE_GET_USER_BODY_COMPOSITION', goReady: false },
  // ✗ wrapper (getBodyCompositionScan) exists, no non-test caller
  { method: 'GET', path: '/api/:user/body-composition/:scanDate', env: 'STRIDE_ROUTE_GET_USER_BODY_COMPOSITION_SCANDATE', goReady: false },
  // ✓ /body-composition · summary + deltas
  { method: 'GET', path: '/api/:user/body-composition/summary', env: 'STRIDE_ROUTE_GET_USER_BODY_COMPOSITION_SUMMARY', goReady: false },
  // ✓ /body-composition · add / edit a body scan
  { method: 'POST', path: '/api/:user/body-composition', env: 'STRIDE_ROUTE_POST_USER_BODY_COMPOSITION', goReady: false },

  // ── Ability / PBs / race predictions ────────────────────────────────────
  // ✓ /ability · current ability snapshot
  { method: 'GET', path: '/api/:user/ability/current', env: 'STRIDE_ROUTE_GET_USER_ABILITY_CURRENT', goReady: false },
  // ✓ /ability · ability history chart
  { method: 'GET', path: '/api/:user/ability/history', env: 'STRIDE_ROUTE_GET_USER_ABILITY_HISTORY', goReady: false },
  // ✓ /ability · ability layer weights
  { method: 'GET', path: '/api/:user/ability/weights', env: 'STRIDE_ROUTE_GET_USER_ABILITY_WEIGHTS', goReady: false },
  // ✓ /ability · backfill ability history
  { method: 'POST', path: '/api/:user/ability/backfill', env: 'STRIDE_ROUTE_POST_USER_ABILITY_BACKFILL', goReady: false },
  // ✓ /ability · personal bests
  { method: 'GET', path: '/api/:user/pbs', env: 'STRIDE_ROUTE_GET_USER_PBS', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/:user/race-predictions', env: 'STRIDE_ROUTE_GET_USER_RACE_PREDICTIONS', goReady: false },
  // ✗ not called
  { method: 'GET', path: '/api/:user/race-predictions/history', env: 'STRIDE_ROUTE_GET_USER_RACE_PREDICTIONS_HISTORY', goReady: false },

  // ── Nutrition ───────────────────────────────────────────────────────────
  // ✗ not called
  { method: 'GET', path: '/api/:user/nutrition/meals', env: 'STRIDE_ROUTE_GET_USER_NUTRITION_MEALS', goReady: false },
  // ✗ not called
  { method: 'POST', path: '/api/:user/nutrition/meals', env: 'STRIDE_ROUTE_POST_USER_NUTRITION_MEALS', goReady: false },

  // ── Plan variants / scheduled sessions ──────────────────────────────────
  // ✗ wrapper (getPlanToday) exists, no non-test caller
  { method: 'GET', path: '/api/:user/plan/today', env: 'STRIDE_ROUTE_GET_USER_PLAN_TODAY', goReady: false },
  // ✓ /, /week, /coach/week, /plan/adjust · planned-vs-actual calendar
  { method: 'GET', path: '/api/:user/plan/days', env: 'STRIDE_ROUTE_GET_USER_PLAN_DAYS', goReady: false },
  // ✓ /, /week · multi-variant comparison
  { method: 'GET', path: '/api/:user/plan/:folder/variants', env: 'STRIDE_ROUTE_GET_USER_PLAN_FOLDER_VARIANTS', goReady: false },
  // ✗ not called
  { method: 'POST', path: '/api/:user/plan/:folder/variants', env: 'STRIDE_ROUTE_POST_USER_PLAN_FOLDER_VARIANTS', goReady: false },
  // ✗ wrapper (deletePlanVariants) exists, no non-test caller
  { method: 'DELETE', path: '/api/:user/plan/:folder/variants', env: 'STRIDE_ROUTE_DELETE_USER_PLAN_FOLDER_VARIANTS', goReady: false },
  // ✓ /, /week · rate a plan variant
  { method: 'POST', path: '/api/:user/plan/variants/:variantId/rate', env: 'STRIDE_ROUTE_POST_USER_PLAN_VARIANTS_VARIANTID_RATE', goReady: false },
  // ✓ /, /week · select the canonical variant
  { method: 'POST', path: '/api/:user/plan/:folder/select', env: 'STRIDE_ROUTE_POST_USER_PLAN_FOLDER_SELECT', goReady: false },
  // ✗ not called (session-level push is used instead)
  { method: 'POST', path: '/api/:user/plan/:folder/push', env: 'STRIDE_ROUTE_POST_USER_PLAN_FOLDER_PUSH', goReady: false },
  // ✓ /, /week, /coach/week · push a planned session to the watch
  { method: 'POST', path: '/api/:user/plan/sessions/:date/:sessionIndex/push', env: 'STRIDE_ROUTE_POST_USER_PLAN_SESSIONS_DATE_SESSIONINDEX_PUSH', goReady: false },
  // ✗ not called
  { method: 'POST', path: '/api/:user/plan/weeks/generate', env: 'STRIDE_ROUTE_POST_USER_PLAN_WEEKS_GENERATE', goReady: false },
  // ✗ not called
  { method: 'POST', path: '/api/:user/workout/run', env: 'STRIDE_ROUTE_POST_USER_WORKOUT_RUN', goReady: false },

  // ── Teams & social ──────────────────────────────────────────────────────
  // ✓ /teams, /teams/:id · my team memberships
  { method: 'GET', path: '/api/users/me/teams', env: 'STRIDE_ROUTE_GET_USERS_ME_TEAMS', goReady: false },
  // ✓ /teams · list all teams
  { method: 'GET', path: '/api/teams', env: 'STRIDE_ROUTE_GET_TEAMS', goReady: false },
  // ✓ /teams/new · create a team
  { method: 'POST', path: '/api/teams', env: 'STRIDE_ROUTE_POST_TEAMS', goReady: false },
  // ✓ /teams/:id · team detail
  { method: 'GET', path: '/api/teams/:teamId', env: 'STRIDE_ROUTE_GET_TEAMS_TEAMID', goReady: false },
  // ✓ /teams/:id · delete team
  { method: 'DELETE', path: '/api/teams/:teamId', env: 'STRIDE_ROUTE_DELETE_TEAMS_TEAMID', goReady: false },
  // ✓ /teams/:id · team member list
  { method: 'GET', path: '/api/teams/:teamId/members', env: 'STRIDE_ROUTE_GET_TEAMS_TEAMID_MEMBERS', goReady: false },
  // ✓ /teams/:id · team activity feed
  { method: 'GET', path: '/api/teams/:teamId/feed', env: 'STRIDE_ROUTE_GET_TEAMS_TEAMID_FEED', goReady: false },
  // ✓ /teams/:id · mileage leaderboard
  { method: 'GET', path: '/api/teams/:teamId/mileage', env: 'STRIDE_ROUTE_GET_TEAMS_TEAMID_MILEAGE', goReady: false },
  // ✓ /teams, /teams/:id · join team
  { method: 'POST', path: '/api/teams/:teamId/join', env: 'STRIDE_ROUTE_POST_TEAMS_TEAMID_JOIN', goReady: false },
  // ✓ /teams/:id · leave team
  { method: 'POST', path: '/api/teams/:teamId/leave', env: 'STRIDE_ROUTE_POST_TEAMS_TEAMID_LEAVE', goReady: false },
  // ✓ /teams/:id · sync all members
  { method: 'POST', path: '/api/teams/:teamId/sync-all', env: 'STRIDE_ROUTE_POST_TEAMS_TEAMID_SYNC_ALL', goReady: false },
  // ✓ /teams/:id · transfer ownership
  { method: 'POST', path: '/api/teams/:teamId/transfer-owner', env: 'STRIDE_ROUTE_POST_TEAMS_TEAMID_TRANSFER_OWNER', goReady: false },
  // ✓ /activity/:id (team view) · load a teammate's activity detail
  { method: 'GET', path: '/api/teams/:teamId/activities/:userId/:labelId', env: 'STRIDE_ROUTE_GET_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID', goReady: false },
  // ✓ /teams/:id · activity like list
  { method: 'GET', path: '/api/teams/:teamId/activities/:userId/:labelId/likes', env: 'STRIDE_ROUTE_GET_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID_LIKES', goReady: false },
  // ✓ /teams/:id · like an activity
  { method: 'POST', path: '/api/teams/:teamId/activities/:userId/:labelId/likes', env: 'STRIDE_ROUTE_POST_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID_LIKES', goReady: false },
  // ✓ /teams/:id · unlike an activity
  { method: 'DELETE', path: '/api/teams/:teamId/activities/:userId/:labelId/likes', env: 'STRIDE_ROUTE_DELETE_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID_LIKES', goReady: false },
]
