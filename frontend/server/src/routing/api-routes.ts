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

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiRoute {
  readonly method: HttpMethod;
  /** Path pattern under /api; `:seg` matches one segment. */
  readonly path: string;
  /**
   * Environment variable that selects this endpoint's upstream. Set it to `go`
   * (case-insensitive) to route this method+path to the Go API; unset/empty/any
   * other value keeps it on Python.
   */
  readonly env: string;
  /** True when the Go API implements this exact method+path (cutover candidate). */
  readonly goReady: boolean;
}

export const API_ROUTES: readonly ApiRoute[] = [
  // ── Liveness / users list ───────────────────────────────────────────────
  // ✗ BFF has its own /healthz; this proxies to Python's health.
  { method: "GET", path: "/api/health", env: "STRIDE_ROUTE_GET_HEALTH", goReady: false },
  // ✗ wrapper (getUsers) exists but only exercised in tests.
  { method: "GET", path: "/api/users", env: "STRIDE_ROUTE_GET_USERS", goReady: false },

  // ── Profile & account (users/me) ────────────────────────────────────────
  // ✓ global(layout) · load profile on app boot / onboarding gate   [go-ready]
  //   Frontend accepts Go's watch_ready and Python's legacy coros_ready.
  { method: "GET", path: "/api/users/me/profile", env: "STRIDE_ROUTE_GET_USERS_ME_PROFILE", goReady: true },
  // ✓ /onboarding · submit basic profile   [go-ready] (same watch_ready caveat)
  { method: "POST", path: "/api/users/me/profile", env: "STRIDE_ROUTE_POST_USERS_ME_PROFILE", goReady: true },
  // ✓ /settings · edit the six Go-owned profile fields   [go-ready]
  { method: "PATCH", path: "/api/users/me/profile", env: "STRIDE_ROUTE_PATCH_USERS_ME_PROFILE", goReady: true },
  // ✓ /onboarding, /settings · injury records   [go-ready]
  { method: "GET", path: "/api/users/me/injuries", env: "STRIDE_ROUTE_GET_USERS_ME_INJURIES", goReady: true },
  { method: "POST", path: "/api/users/me/injuries", env: "STRIDE_ROUTE_POST_USERS_ME_INJURIES", goReady: true },
  { method: "PUT", path: "/api/users/me/injuries/:injuryId", env: "STRIDE_ROUTE_PUT_USERS_ME_INJURIES_INJURYID", goReady: true },
  { method: "DELETE", path: "/api/users/me/injuries/:injuryId", env: "STRIDE_ROUTE_DELETE_USERS_ME_INJURIES_INJURYID", goReady: true },
  // ✓ /settings · delete account [go-ready]
  //   Watch credentials are Go/MySQL-owned. Account deletion must use the same
  //   upstream so DeleteUserData removes provider_credentials atomically.
  { method: "DELETE", path: "/api/users/me", env: "STRIDE_ROUTE_DELETE_USERS_ME", goReady: true },
  // ✓ /settings + global(layout) · watch info + sync pill state   [ON GO]
  //   Sync (POST /api/:user/sync) and watch login (POST /api/users/me/watch/login)
  //   both run on Go, so the per-user watch state lives in Tencent MySQL
  //   (provider_credentials + sync_meta.last_sync_time). The Python/Azure store is
  //   no longer written by any watch flow, so serving this from Python would show
  //   a stale/empty last_sync_at after a Go sync. Set env to 'go' to read it from
  //   Go — this is what keeps the sync pill's "上一次数据同步时间" current.
  { method: "GET", path: "/api/users/me/watch", env: "STRIDE_ROUTE_GET_USERS_ME_WATCH", goReady: true },
  // ✓ /settings · disconnect watch
  //   Must follow GET watch to the same upstream: Python still serves it, its
  //   disconnect would delete the Azure credential only, leaving the MySQL one
  //   orphaned (the cross-store drift #299 reverted for).
  { method: "DELETE", path: "/api/users/me/watch", env: "STRIDE_ROUTE_DELETE_USERS_ME_WATCH", goReady: true },
  // ✓ /onboarding, /settings · unified Go watch login
  { method: "POST", path: "/api/users/me/watch/login", env: "STRIDE_ROUTE_POST_USERS_ME_WATCH_LOGIN", goReady: true },

  // ── Onboarding & sync ───────────────────────────────────────────────────
  // ✓ /onboarding · explicitly finalize a completed onboarding run [go-ready]
  //   Web onboarding must also cut over profile GET/POST, watch login,
  //   POST /api/:user/sync, and GET /api/pipelines/:run_id. Pipeline success alone
  //   is not completion.
  { method: "POST", path: "/api/users/me/onboarding/complete", env: "STRIDE_ROUTE_POST_USERS_ME_ONBOARDING_COMPLETE", goReady: true },
  // ✓ global(layout) · manual sync from the sync pill
  //   Go note: starts an async data-sync pipeline (sync + compute) and returns
  //   202 {run_id} to poll GET /pipelines/:id (ADR 0020), vs Python's
  //   synchronous {success,output}. Cutover needs the pill to poll — not just routing.
  { method: "POST", path: "/api/:user/sync", env: "STRIDE_ROUTE_POST_USER_SYNC", goReady: true },
  // ✓ sync callers · poll one Go pipeline returned by POST /api/:user/sync
  { method: "GET", path: "/api/pipelines/:run_id", env: "STRIDE_ROUTE_GET_PIPELINES_RUNID", goReady: true },
  // ✓ /onboarding · read the active step's job progress [go-ready]
  { method: "GET", path: "/api/jobs/:job_id", env: "STRIDE_ROUTE_GET_JOBS_JOBID", goReady: true },
  // ✓ /onboarding · poll the current user's Go pipeline run
  { method: "GET", path: "/api/users/:user/pipelines", env: "STRIDE_ROUTE_GET_USERS_USER_PIPELINES", goReady: true },

  // ── Training goal / preferences ───────────────────────────────────────────
  // TrainingPlanPage.tsx:207
  // 在创建训练计划的时候需要获取用户的目标
  // ✓ /plan · load current training goal   [go-ready]
  { method: "GET", path: "/api/users/me/training-goal", env: "STRIDE_ROUTE_GET_USERS_ME_TRAINING_GOAL", goReady: true },
  // ✓ /plan · create race training goal   [go-ready]
  { method: "POST", path: "/api/users/me/training-goal", env: "STRIDE_ROUTE_POST_USERS_ME_TRAINING_GOAL", goReady: true },
  // ✗ not called   [go-ready]
  { method: "PUT", path: "/api/users/me/training-goal", env: "STRIDE_ROUTE_PUT_USERS_ME_TRAINING_GOAL", goReady: true },
  // ✗ not called
  { method: "GET", path: "/api/users/me/nutrition-prefs", env: "STRIDE_ROUTE_GET_USERS_ME_NUTRITION_PREFS", goReady: false },
  // ✗ not called
  { method: "PUT", path: "/api/users/me/nutrition-prefs", env: "STRIDE_ROUTE_PUT_USERS_ME_NUTRITION_PREFS", goReady: false },
  // ✗ not called
  { method: "GET", path: "/api/users/me/notification-prefs", env: "STRIDE_ROUTE_GET_USERS_ME_NOTIFICATION_PREFS", goReady: false },
  // ✗ not called
  { method: "PATCH", path: "/api/users/me/notification-prefs", env: "STRIDE_ROUTE_PATCH_USERS_ME_NOTIFICATION_PREFS", goReady: false },

  // ── Notifications & push devices ────────────────────────────────────────
  // ✓ global(layout) · message-center notifications list
  { method: "GET", path: "/api/users/me/notifications", env: "STRIDE_ROUTE_GET_USERS_ME_NOTIFICATIONS", goReady: false },
  // ✓ global(layout) · notifications read state (unread badge)
  { method: "GET", path: "/api/users/me/notifications/read-state", env: "STRIDE_ROUTE_GET_USERS_ME_NOTIFICATIONS_READ_STATE", goReady: false },
  // ✓ global(layout) · mark a notification read
  {
    method: "POST",
    path: "/api/users/me/notifications/:notificationId/read",
    env: "STRIDE_ROUTE_POST_USERS_ME_NOTIFICATIONS_NOTIFICATIONID_READ",
    goReady: false,
  },
  // ✗ not called (push registration not wired in web)
  { method: "POST", path: "/api/users/me/devices", env: "STRIDE_ROUTE_POST_USERS_ME_DEVICES", goReady: false },
  // ✗ not called
  { method: "DELETE", path: "/api/users/me/devices/:registrationId", env: "STRIDE_ROUTE_DELETE_USERS_ME_DEVICES_REGISTRATIONID", goReady: false },

  // ── Master plan (season plan) ───────────────────────────────────────────
  // ✓ /plan, /plan/adjust · load active season plan   [go-ready]
  { method: "GET", path: "/api/users/:user_id/master-plan/current", env: "STRIDE_ROUTE_GET_USERS_USER_ID_MASTER_PLAN_CURRENT", goReady: true },
  // ✓ /plan · load draft season plan (404 = no draft, expected)
  { method: "GET", path: "/api/users/me/master-plan/draft", env: "STRIDE_ROUTE_GET_USERS_ME_MASTER_PLAN_DRAFT", goReady: false },
  // ✓ /plan, /coach/master/:planId/adjust · load plan by id
  { method: "GET", path: "/api/users/me/master-plan/:planId", env: "STRIDE_ROUTE_GET_USERS_ME_MASTER_PLAN_PLANID", goReady: false },
  // ✗ not called
  { method: "GET", path: "/api/users/me/master-plan/:planId/versions", env: "STRIDE_ROUTE_GET_USERS_ME_MASTER_PLAN_PLANID_VERSIONS", goReady: false },
  // ✗ not called
  {
    method: "GET",
    path: "/api/users/me/master-plan/:planId/versions/:versionNumber",
    env: "STRIDE_ROUTE_GET_USERS_ME_MASTER_PLAN_PLANID_VERSIONS_VERSIONNUMBER",
    goReady: false,
  },
  // ✓ /plan · poll season-plan generation job
  { method: "GET", path: "/api/users/me/master-plan/jobs/:jobId", env: "STRIDE_ROUTE_GET_USERS_ME_MASTER_PLAN_JOBS_JOBID", goReady: false },
  // ✓ /plan · start season-plan generation
  { method: "POST", path: "/api/users/me/master-plan/generate", env: "STRIDE_ROUTE_POST_USERS_ME_MASTER_PLAN_GENERATE", goReady: false },
  // ✓ /plan · review-chat message on the draft
  {
    method: "POST",
    path: "/api/users/me/master-plan/:planId/review/messages",
    env: "STRIDE_ROUTE_POST_USERS_ME_MASTER_PLAN_PLANID_REVIEW_MESSAGES",
    goReady: false,
  },
  // ✓ /plan · apply reviewed diff to the draft
  { method: "POST", path: "/api/users/me/master-plan/:planId/review/apply", env: "STRIDE_ROUTE_POST_USERS_ME_MASTER_PLAN_PLANID_REVIEW_APPLY", goReady: false },
  // ✓ /plan · promote draft to active
  { method: "POST", path: "/api/users/me/master-plan/:planId/confirm", env: "STRIDE_ROUTE_POST_USERS_ME_MASTER_PLAN_PLANID_CONFIRM", goReady: false },
  // ✓ /plan/adjust · adjust-chat message
  {
    method: "POST",
    path: "/api/users/me/master-plan/:planId/adjust/messages",
    env: "STRIDE_ROUTE_POST_USERS_ME_MASTER_PLAN_PLANID_ADJUST_MESSAGES",
    goReady: false,
  },
  // ✓ /plan/adjust · apply adjustment diff
  { method: "POST", path: "/api/users/me/master-plan/:planId/adjust/apply", env: "STRIDE_ROUTE_POST_USERS_ME_MASTER_PLAN_PLANID_ADJUST_APPLY", goReady: false },

  // ── Coach ───────────────────────────────────────────────────────────────
  // ✓ /coach + /coach/*/adjust · send a coach chat turn
  { method: "POST", path: "/api/users/me/coach/chat", env: "STRIDE_ROUTE_POST_USERS_ME_COACH_CHAT", goReady: false },
  // ✓ /coach/week/:folder/adjust · apply weekly coach proposal
  { method: "POST", path: "/api/users/me/coach/plan/:folder/apply", env: "STRIDE_ROUTE_POST_USERS_ME_COACH_PLAN_FOLDER_APPLY", goReady: false },
  // ✓ /coach/master/:planId/adjust · apply master coach proposal
  { method: "POST", path: "/api/users/me/coach/master-plan/:planId/apply", env: "STRIDE_ROUTE_POST_USERS_ME_COACH_MASTER_PLAN_PLANID_APPLY", goReady: false },
  // ✓ coach adjust pages · record an abandoned proposal
  { method: "POST", path: "/api/users/me/coach/proposals/abandon", env: "STRIDE_ROUTE_POST_USERS_ME_COACH_PROPOSALS_ABANDON", goReady: false },
  // ✓ /coach + adjust pages · load coach chat history
  {
    method: "GET",
    path: "/api/users/me/coach/sessions/:sessionId/messages",
    env: "STRIDE_ROUTE_GET_USERS_ME_COACH_SESSIONS_SESSIONID_MESSAGES",
    goReady: false,
  },

  // ── Activities (per-user, {user} = UUID) ────────────────────────────────
  // ✗ not called
  { method: "GET", path: "/api/:user/home", env: "STRIDE_ROUTE_GET_USER_HOME", goReady: false },
  // ✓ /activities, /plan/adjust, /training-status · list / paginate activities   [go-ready]
  //   Go note (ADR 0019): contract parity incl. monthly_summaries; safe to cut over.
  { method: "GET", path: "/api/:user/activities", env: "STRIDE_ROUTE_GET_USER_ACTIVITIES", goReady: true },
  // ✓ /activity/:id · activity detail (?include=timeseries)   [go-ready]
  //   Go note (ADR 0019): zones projected from activity_watch_zones (watch-reported),
  //   not calibrated zones; linked_scheduled_workout always null — cutover gated on that gap.
  { method: "GET", path: "/api/:user/activities/:labelId", env: "STRIDE_ROUTE_GET_USER_ACTIVITIES_LABELID", goReady: true },
  // ✗ not called (detail uses ?include=timeseries instead)
  { method: "GET", path: "/api/:user/activities/:labelId/timeseries", env: "STRIDE_ROUTE_GET_USER_ACTIVITIES_LABELID_TIMESERIES", goReady: false },
  // ✗ not called
  { method: "GET", path: "/api/:user/activities/:labelId/feedback", env: "STRIDE_ROUTE_GET_USER_ACTIVITIES_LABELID_FEEDBACK", goReady: false },
  // ✗ not called
  { method: "PUT", path: "/api/:user/activities/:labelId/feedback", env: "STRIDE_ROUTE_PUT_USER_ACTIVITIES_LABELID_FEEDBACK", goReady: false },
  // ✓ /activity/:id · ability-contribution card
  { method: "GET", path: "/api/:user/activities/:labelId/ability", env: "STRIDE_ROUTE_GET_USER_ACTIVITIES_LABELID_ABILITY", goReady: false },
  // ✓ /activity/:id · resync this activity from the watch
  { method: "POST", path: "/api/:user/activities/:labelId/resync", env: "STRIDE_ROUTE_POST_USER_ACTIVITIES_LABELID_RESYNC", goReady: false },
  // ✗ not called (only .../commentary/regenerate is used)
  { method: "POST", path: "/api/:user/activities/:labelId/commentary", env: "STRIDE_ROUTE_POST_USER_ACTIVITIES_LABELID_COMMENTARY", goReady: false },
  // ✓ /activity/:id · regenerate AI commentary
  {
    method: "POST",
    path: "/api/:user/activities/:labelId/commentary/regenerate",
    env: "STRIDE_ROUTE_POST_USER_ACTIVITIES_LABELID_COMMENTARY_REGENERATE",
    goReady: false,
  },

  // ── Weeks / weekly plan.md ──────────────────────────────────────────────
  // ✓ /, /week, /plan, /plan/adjust · list weekly-plan folders
  { method: "GET", path: "/api/:user/weeks", env: "STRIDE_ROUTE_GET_USER_WEEKS", goReady: true },
  // ✓ /, /week, /coach/week/:folder/adjust · load week detail
  { method: "GET", path: "/api/:user/weeks/:weekName", env: "STRIDE_ROUTE_GET_USER_WEEKS_WEEKNAME", goReady: true },
  // ✗ not called
  { method: "PUT", path: "/api/:user/weeks/:folder/plan", env: "STRIDE_ROUTE_PUT_USER_WEEKS_FOLDER_PLAN", goReady: false },
  // ✗ not called
  { method: "GET", path: "/api/:user/weeks/:folder/review", env: "STRIDE_ROUTE_GET_USER_WEEKS_FOLDER_REVIEW", goReady: false },
  // ✓ /, /week, /coach/week · weekly strength tab
  { method: "GET", path: "/api/:user/weeks/:folder/strength", env: "STRIDE_ROUTE_GET_USER_WEEKS_FOLDER_STRENGTH", goReady: false },
  // ✓ /, /week, /coach/week · save canonical MySQL weekly feedback [go-ready]
  { method: "PUT", path: "/api/:user/weeks/:weekName/feedback", env: "STRIDE_ROUTE_PUT_USER_WEEKS_WEEKNAME_FEEDBACK", goReady: true },
  // ✓ /, /week · reparse plan.md into structured plan (WeekLayout)
  { method: "POST", path: "/api/:user/plan/reparse", env: "STRIDE_ROUTE_POST_USER_PLAN_REPARSE", goReady: false },

  // ── Health / fitness / training-status ──────────────────────────────────
  // ✗ not called
  { method: "GET", path: "/api/:user/dashboard", env: "STRIDE_ROUTE_GET_USER_DASHBOARD", goReady: false },
  // ✓ /health, /training-status, /plan/adjust · RHR / health records   [go-ready ADR-0023]
  { method: "GET", path: "/api/:user/health", env: "STRIDE_ROUTE_GET_USER_HEALTH", goReady: true },
  // ✓ /health, /plan/adjust · PMC / training-load curve (vendor + STRIDE)   [go-ready ADR-0023]
  { method: "GET", path: "/api/:user/pmc", env: "STRIDE_ROUTE_GET_USER_PMC", goReady: true },
  // ✗ not called
  { method: "GET", path: "/api/:user/stats", env: "STRIDE_ROUTE_GET_USER_STATS", goReady: false },
  // ✓ /health, /training-status, /plan/adjust · HRV daily records   [go-ready ADR-0023]
  { method: "GET", path: "/api/:user/hrv", env: "STRIDE_ROUTE_GET_USER_HRV", goReady: true },
  // ✓ /training-status · STRIDE training-load series   [go-ready ADR-0023]
  { method: "GET", path: "/api/:user/stride/training-load", env: "STRIDE_ROUTE_GET_USER_STRIDE_TRAINING_LOAD", goReady: true },
  // ✓ /training-status, /plan/adjust · pace / HR zones   [go-ready ADR-0023]
  { method: "GET", path: "/api/:user/stride/zones", env: "STRIDE_ROUTE_GET_USER_STRIDE_ZONES", goReady: true },

  // ── Body composition ────────────────────────────────────────────────────
  // ✓ /body-composition · scans list
  { method: "GET", path: "/api/:user/body-composition", env: "STRIDE_ROUTE_GET_USER_BODY_COMPOSITION", goReady: false },
  // ✗ wrapper (getBodyCompositionScan) exists, no non-test caller
  { method: "GET", path: "/api/:user/body-composition/:scanDate", env: "STRIDE_ROUTE_GET_USER_BODY_COMPOSITION_SCANDATE", goReady: false },
  // ✓ /body-composition · summary + deltas
  { method: "GET", path: "/api/:user/body-composition/summary", env: "STRIDE_ROUTE_GET_USER_BODY_COMPOSITION_SUMMARY", goReady: false },
  // ✓ /body-composition · add / edit a body scan
  { method: "POST", path: "/api/:user/body-composition", env: "STRIDE_ROUTE_POST_USER_BODY_COMPOSITION", goReady: false },

  // ── Ability / PBs / race predictions ────────────────────────────────────
  // ✓ /ability · current ability snapshot
  { method: "GET", path: "/api/:user/ability/current", env: "STRIDE_ROUTE_GET_USER_ABILITY_CURRENT", goReady: false },
  // ✓ /ability · ability history chart
  { method: "GET", path: "/api/:user/ability/history", env: "STRIDE_ROUTE_GET_USER_ABILITY_HISTORY", goReady: false },
  // ✓ /ability · ability layer weights
  { method: "GET", path: "/api/:user/ability/weights", env: "STRIDE_ROUTE_GET_USER_ABILITY_WEIGHTS", goReady: false },
  // ✓ /ability · backfill ability history
  { method: "POST", path: "/api/:user/ability/backfill", env: "STRIDE_ROUTE_POST_USER_ABILITY_BACKFILL", goReady: false },
  // ✓ /ability · personal bests
  { method: "GET", path: "/api/:user/pbs", env: "STRIDE_ROUTE_GET_USER_PBS", goReady: false },
  // ✗ not called
  { method: "GET", path: "/api/:user/race-predictions", env: "STRIDE_ROUTE_GET_USER_RACE_PREDICTIONS", goReady: false },
  // ✗ not called
  { method: "GET", path: "/api/:user/race-predictions/history", env: "STRIDE_ROUTE_GET_USER_RACE_PREDICTIONS_HISTORY", goReady: false },

  // ── Nutrition ───────────────────────────────────────────────────────────
  // ✗ not called
  { method: "GET", path: "/api/:user/nutrition/meals", env: "STRIDE_ROUTE_GET_USER_NUTRITION_MEALS", goReady: false },
  // ✗ not called
  { method: "POST", path: "/api/:user/nutrition/meals", env: "STRIDE_ROUTE_POST_USER_NUTRITION_MEALS", goReady: false },

  // ── Plan variants / scheduled sessions ──────────────────────────────────
  // ✗ wrapper (getPlanToday) exists, no non-test caller
  { method: "GET", path: "/api/:user/plan/today", env: "STRIDE_ROUTE_GET_USER_PLAN_TODAY", goReady: false },
  // ✓ /, /week, /coach/week, /plan/adjust · planned-vs-actual calendar
  { method: "GET", path: "/api/:user/plan/days", env: "STRIDE_ROUTE_GET_USER_PLAN_DAYS", goReady: false },
  // ✗ not called   [go-ready]
  { method: "GET", path: "/api/:user/plan/weeks", env: "STRIDE_ROUTE_GET_USER_PLAN_WEEKS", goReady: true },
  // ✓ /, /week · multi-variant comparison
  { method: "GET", path: "/api/:user/plan/:folder/variants", env: "STRIDE_ROUTE_GET_USER_PLAN_FOLDER_VARIANTS", goReady: false },
  // ✗ not called   [go-ready]
  { method: "GET", path: "/api/:user/plan/weeks/:weekName", env: "STRIDE_ROUTE_GET_USER_PLAN_WEEKS_WEEKNAME", goReady: true },
  // ✗ not called
  { method: "POST", path: "/api/:user/plan/:folder/variants", env: "STRIDE_ROUTE_POST_USER_PLAN_FOLDER_VARIANTS", goReady: false },
  // ✗ wrapper (deletePlanVariants) exists, no non-test caller
  { method: "DELETE", path: "/api/:user/plan/:folder/variants", env: "STRIDE_ROUTE_DELETE_USER_PLAN_FOLDER_VARIANTS", goReady: false },
  // ✓ /, /week · rate a plan variant
  { method: "POST", path: "/api/:user/plan/variants/:variantId/rate", env: "STRIDE_ROUTE_POST_USER_PLAN_VARIANTS_VARIANTID_RATE", goReady: false },
  // ✓ /, /week · select the canonical variant
  { method: "POST", path: "/api/:user/plan/:folder/select", env: "STRIDE_ROUTE_POST_USER_PLAN_FOLDER_SELECT", goReady: false },
  // ✗ not called (session-level push is used instead)
  { method: "POST", path: "/api/:user/plan/:folder/push", env: "STRIDE_ROUTE_POST_USER_PLAN_FOLDER_PUSH", goReady: false },
  // ✓ /, /week, /coach/week · push a planned session to the watch
  {
    method: "POST",
    path: "/api/:user/plan/sessions/:date/:sessionIndex/push",
    env: "STRIDE_ROUTE_POST_USER_PLAN_SESSIONS_DATE_SESSIONINDEX_PUSH",
    goReady: false,
  },
  // ✗ not called
  { method: "POST", path: "/api/:user/plan/weeks/generate", env: "STRIDE_ROUTE_POST_USER_PLAN_WEEKS_GENERATE", goReady: false },
  // ✗ not called
  { method: "POST", path: "/api/:user/workout/run", env: "STRIDE_ROUTE_POST_USER_WORKOUT_RUN", goReady: false },

  // ── Teams & social ──────────────────────────────────────────────────────
  // ✓ /teams, /teams/:id · my team memberships   [go-ready]
  { method: "GET", path: "/api/users/me/teams", env: "STRIDE_ROUTE_GET_USERS_ME_TEAMS", goReady: true },
  // ✓ /teams · list all teams   [go-ready]
  { method: "GET", path: "/api/teams", env: "STRIDE_ROUTE_GET_TEAMS", goReady: true },
  // ✓ /teams/new · create a team   [go-ready]
  { method: "POST", path: "/api/teams", env: "STRIDE_ROUTE_POST_TEAMS", goReady: true },
  // ✓ /teams/:id · team detail   [go-ready]
  { method: "GET", path: "/api/teams/:teamId", env: "STRIDE_ROUTE_GET_TEAMS_TEAMID", goReady: true },
  // ✓ /teams/:id · delete team   [go-ready]
  { method: "DELETE", path: "/api/teams/:teamId", env: "STRIDE_ROUTE_DELETE_TEAMS_TEAMID", goReady: true },
  // ✓ /teams/:id · team member list   [go-ready]
  { method: "GET", path: "/api/teams/:teamId/members", env: "STRIDE_ROUTE_GET_TEAMS_TEAMID_MEMBERS", goReady: true },
  // ✓ /teams/:id · team activity feed   [go-ready]
  { method: "GET", path: "/api/teams/:teamId/feed", env: "STRIDE_ROUTE_GET_TEAMS_TEAMID_FEED", goReady: true },
  // ✓ /teams/:id · mileage leaderboard   [go-ready]
  { method: "GET", path: "/api/teams/:teamId/mileage", env: "STRIDE_ROUTE_GET_TEAMS_TEAMID_MILEAGE", goReady: true },
  // ✓ /teams, /teams/:id · join team   [go-ready]
  { method: "POST", path: "/api/teams/:teamId/join", env: "STRIDE_ROUTE_POST_TEAMS_TEAMID_JOIN", goReady: true },
  // ✓ /teams/:id · leave team   [go-ready]
  { method: "POST", path: "/api/teams/:teamId/leave", env: "STRIDE_ROUTE_POST_TEAMS_TEAMID_LEAVE", goReady: true },
  // ✓ /teams/:id · sync all members (Python only; orchestration is not migrated)
  { method: "POST", path: "/api/teams/:teamId/sync-all", env: "STRIDE_ROUTE_POST_TEAMS_TEAMID_SYNC_ALL", goReady: false },
  // ✓ /teams/:id · transfer ownership   [go-ready]
  { method: "POST", path: "/api/teams/:teamId/transfer-owner", env: "STRIDE_ROUTE_POST_TEAMS_TEAMID_TRANSFER_OWNER", goReady: true },
  // ✓ /activity/:id (team view) · load a teammate's activity detail   [go-ready]
  { method: "GET", path: "/api/teams/:teamId/activities/:userId/:labelId", env: "STRIDE_ROUTE_GET_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID", goReady: true },
  // ✓ /teams/:id · activity like list   [go-ready]
  {
    method: "GET",
    path: "/api/teams/:teamId/activities/:userId/:labelId/likes",
    env: "STRIDE_ROUTE_GET_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID_LIKES",
    goReady: true,
  },
  // ✓ /teams/:id · like an activity   [go-ready]
  {
    method: "POST",
    path: "/api/teams/:teamId/activities/:userId/:labelId/likes",
    env: "STRIDE_ROUTE_POST_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID_LIKES",
    goReady: true,
  },
  // ✓ /teams/:id · unlike an activity   [go-ready]
  {
    method: "DELETE",
    path: "/api/teams/:teamId/activities/:userId/:labelId/likes",
    env: "STRIDE_ROUTE_DELETE_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID_LIKES",
    goReady: true,
  },
];
