import { refreshAccessToken } from './store/authStore'
import type {
  AbandonedScheduledWorkout,
  PlannedNutrition,
  PlannedSession,
  StructuredStatus,
  VariantsSummary,
} from './types/plan'

const BASE = '/api'

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

function authHeaders(): HeadersInit {
  const token = sessionStorage.getItem('access_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * Single HTTP entrypoint. Handles auth header injection, 401 → refresh →
 * retry (once), and the "refresh failed → boot to /login" tear-down. All
 * higher-level wrappers (fetchJSON / postJSON / putJSON / patchJSON /
 * deleteJSON) are thin shells over this — change request-id, abort,
 * telemetry, or error-normalization here once, not in 5 places.
 */
async function apiFetch(
  method: HttpMethod,
  path: string,
  body?: unknown,
): Promise<Response> {
  // POST/PUT/PATCH historically always set Content-Type, even when the
  // caller passes no body (e.g. postOnboardingComplete). Preserved.
  const setsJsonHeader = method === 'POST' || method === 'PUT' || method === 'PATCH'
  // Rebuilt on each attempt because `authHeaders()` reads the *current*
  // access_token from sessionStorage, which refreshAccessToken mutates.
  const buildInit = (): RequestInit => ({
    method,
    headers: { ...authHeaders(), ...(setsJsonHeader ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let res = await fetch(`${BASE}${path}`, buildInit())
  if (res.status === 401) {
    try {
      await refreshAccessToken()
      res = await fetch(`${BASE}${path}`, buildInit())
    } catch {
      sessionStorage.clear()
      window.location.href = '/login'
      throw new Error('Session expired')
    }
  }
  return res
}

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await apiFetch('GET', path)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

type JsonResult<T> = { ok: boolean; status: number; data: T }

async function bodyResult<T>(res: Response): Promise<JsonResult<T>> {
  const data = await res.json().catch(() => ({} as T))
  return { ok: res.ok, status: res.status, data: data as T }
}

const postJSON = async <T>(path: string, body?: unknown): Promise<JsonResult<T>> =>
  bodyResult<T>(await apiFetch('POST', path, body))
const putJSON = async <T>(path: string, body?: unknown): Promise<JsonResult<T>> =>
  bodyResult<T>(await apiFetch('PUT', path, body))
const patchJSON = async <T>(path: string, body?: unknown): Promise<JsonResult<T>> =>
  bodyResult<T>(await apiFetch('PATCH', path, body))
const deleteJSON = async <T>(path: string): Promise<JsonResult<T>> =>
  bodyResult<T>(await apiFetch('DELETE', path))

export function getUsers() {
  return fetchJSON<{ users: string[] }>('/users')
}

export interface MyProfile {
  id: string
  display_name: string
  profile: Record<string, unknown> | null
  onboarding: {
    coros_ready: boolean
    profile_ready: boolean
    completed_at: string | null
  }
  // Connected watch provider — `'coros' | 'garmin'` when the backend exposes
  // it. Currently the /api/users/me/profile route doesn't return this field,
  // so callers should treat `undefined` as "fall back to coros default".
  provider?: string | null
}

export function getMyProfile() {
  return fetchJSON<MyProfile>('/users/me/profile')
}

export type TargetDistance = '5K' | '10K' | 'HM' | 'FM'

export interface ProfileIn {
  display_name: string
  dob: string
  sex: string
  height_cm: number
  weight_kg: number
  // Race goal fields — optional during onboarding, filled later in training
  // plan setup when the user chooses a target race.
  target_race?: string
  target_distance?: TargetDistance
  target_race_date?: string
  target_time?: string
  pbs?: Record<string, string>
  weekly_mileage_km?: number
  constraints?: string
}

export type ProfilePatchIn = Partial<ProfileIn>

export function postCorosLogin(email: string, password: string) {
  return postJSON<{ region?: string; user_id?: string; error?: string; detail?: unknown }>(
    '/users/me/coros/login',
    { email, password },
  )
}

export function postGarminLogin(
  email: string,
  password: string,
  region: 'cn' | 'global' = 'cn',
) {
  return postJSON<{ region?: string; user_id?: string; error?: string; detail?: unknown }>(
    '/users/me/garmin/login',
    { email, password, region },
  )
}

export function postProfile(profile: ProfileIn) {
  return postJSON<{ error?: string; detail?: unknown }>('/users/me/profile', profile)
}

export type RunningAge = 'lt_6m' | '6m_1y' | '1y_3y' | '3y_plus'
export type CurrentWeeklyKm = 'lt_20' | '20_40' | '40_60' | '60_plus'
export type RunningPbDistance = '5K' | '10K' | 'HM' | 'FM'

export interface RunningProfilePb {
  distance: RunningPbDistance
  time: string
}

export interface RunningProfileInput {
  running_age: RunningAge
  current_weekly_km: CurrentWeeklyKm
  pbs: RunningProfilePb[]
  injuries: string[]
}

export interface RunningProfile extends RunningProfileInput {
  profile_id?: string
  created_at?: string
  updated_at?: string
}

export function createRunningProfile(profile: RunningProfileInput) {
  return postJSON<RunningProfile & { error?: string; detail?: unknown }>(
    '/users/me/running-profile',
    profile,
  )
}

export function patchMyProfile(patch: ProfilePatchIn) {
  return patchJSON<{
    ok?: boolean
    id?: string
    display_name?: string | null
    profile?: Record<string, unknown>
    detail?: unknown
  }>('/users/me/profile', patch)
}

export function deleteMyAccount() {
  return deleteJSON<{ detail?: unknown }>('/users/me')
}

// ---------------------------------------------------------------------------
// Watch management
// ---------------------------------------------------------------------------

export interface WatchInfo {
  provider: string | null
  provider_display_name: string | null
  logged_in: boolean
  email: string | null
  device: string | null
  last_sync_at: string | null
  capabilities: string[]
}

export function getWatchInfo() {
  return fetchJSON<WatchInfo>('/users/me/watch')
}

export function disconnectWatch() {
  return deleteJSON<{ ok: boolean; provider: string }>('/users/me/watch')
}

export function postOnboardingComplete() {
  return postJSON<{ state?: string; error?: string; detail?: string; progress?: SyncProgress }>('/users/me/onboarding/complete')
}

export interface SyncProgress {
  phase?: string
  failed_phase?: string
  message?: string
  percent?: number
  current?: number
  total?: number
  synced_activities?: number
  synced_health?: number
  started_at?: string
  updated_at?: string
}

export interface SyncStatus {
  state: 'running' | 'done' | 'error' | null
  error?: string
  progress?: SyncProgress | null
}

export function getSyncStatus() {
  return fetchJSON<SyncStatus>('/users/me/sync-status')
}

export interface NotificationReadState {
  read_ids: string[]
}

export function getNotificationReadState() {
  return fetchJSON<NotificationReadState>('/users/me/notifications/read-state')
}

export async function markNotificationRead(notificationId: string) {
  const encoded = encodeURIComponent(notificationId)
  const res = await postJSON<NotificationReadState>(`/users/me/notifications/${encoded}/read`)
  if (!res.ok) throw new Error(`mark notification read failed: HTTP ${res.status}`)
  return res.data
}

// ─── Full sync (training plan setup) ──────────────────────────────────────

export function postFullSync() {
  return postJSON<{ state?: string; error?: string; detail?: string; progress?: SyncProgress }>(
    '/users/me/full-sync',
  )
}

export function getFullSyncStatus() {
  return fetchJSON<SyncStatus>('/users/me/full-sync-status')
}

export interface Activity {
  label_id: string
  name: string | null
  sport_type: number
  sport_name: string
  date: string
  distance_m: number
  distance_km: number
  duration_s: number
  duration_fmt: string
  avg_pace_s_km: number | null
  pace_fmt: string
  avg_hr: number | null
  max_hr: number | null
  avg_cadence: number | null
  calories_kcal: number | null
  training_load: number | null
  vo2max: number | null
  train_type: string | null
  ascent_m: number | null
  aerobic_effect: number | null
  anaerobic_effect: number | null
  temperature: number | null
  humidity: number | null
  feels_like: number | null
  wind_speed: number | null
  feel_type: number | null
  sport_note: string | null
  commentary?: string
  commentary_generated_by?: string | null
  commentary_generated_at?: string | null
  // Watch-paused intervals (decoded from JSON server-side). Empty list
  // when no pauses or for legacy synced rows.
  pauses?: Pause[]
  // Pre-computed route polyline for activity-list thumbnails. Each point
  // is [x, y] in a 0..100 SVG viewport (Y already flipped). Null when
  // the activity has no GPS (indoor/strength) or hasn't been backfilled.
  route_thumb?: number[][] | null
}

export interface Lap {
  lap_index: number
  lap_type: string
  distance_m: number
  distance_km: number
  duration_s: number
  duration_fmt: string
  avg_pace: number | null
  pace_fmt: string
  adjusted_pace: number | null
  avg_hr: number | null
  max_hr: number | null
  avg_cadence: number | null
  avg_power: number | null
  ascent_m: number | null
  descent_m: number | null
}

export interface Zone {
  zone_type: string
  zone_index: number
  range_min: number | null
  range_max: number | null
  range_unit: string
  duration_s: number
  percent: number
}

export interface TimeseriesPoint {
  timestamp: number | null
  distance: number | null
  heart_rate: number | null
  speed: number | null
  adjusted_pace: number | null
  cadence: number | null
  altitude: number | null
  power: number | null
  // WGS84 GPS, decimal degrees. NULL when device had no fix or for indoor
  // activities. Frontend AMap rendering must apply WGS84→GCJ02 transform.
  gps_lat: number | null
  gps_lon: number | null
}

// Watch-paused interval. Timestamps are raw COROS centiseconds, same shape
// as `TimeseriesPoint.timestamp` — convert to elapsed seconds the same way
// HRChart/PaceChart already do (subtract activity start, divide by 100).
export interface Pause {
  start_ts: number | null
  end_ts: number | null
  type: number | null
}

export interface WeekSummary {
  folder: string
  date_from: string
  date_to: string
  has_plan: boolean
  has_feedback: boolean
  has_body_composition: boolean
  plan_title?: string
  activity_count: number
  total_km: number
  total_duration_s: number
  total_duration_fmt: string
}

export interface WeekDetail {
  folder: string
  date_from: string
  date_to: string
  plan?: string
  feedback?: string
  feedback_source?: 'db' | 'file' | 'none'
  feedback_updated_at?: string | null
  feedback_generated_by?: string | null
  activities: Activity[]
  total_km: number
  total_duration_s: number
  total_duration_fmt: string
  activity_count: number
  // Multi-variant additions (Step 4 backend additive fields).
  variants_summary?: VariantsSummary
  abandoned_scheduled_workouts?: AbandonedScheduledWorkout[]
}

export interface ActivitiesListResponse {
  total: number
  offset: number
  limit: number
  activities: Activity[]
  monthly_summaries?: Record<string, ActivityMonthlySummary>
}

export interface ActivityMonthlySummary {
  activity_count: number
  total_run_km: number
  duration_s: number
}

export function getActivities(
  user: string,
  opts: {
    dateFrom?: string
    dateTo?: string
    limit?: number
    offset?: number
    sport?: string
    sportCategory?: 'run' | 'strength'
    minDistanceKm?: number
  } = {},
) {
  const params = new URLSearchParams()
  if (opts.dateFrom) params.set('date_from', opts.dateFrom)
  if (opts.dateTo) params.set('date_to', opts.dateTo)
  if (opts.limit != null) params.set('limit', String(opts.limit))
  if (opts.offset != null) params.set('offset', String(opts.offset))
  if (opts.sport) params.set('sport', opts.sport)
  if (opts.sportCategory) params.set('sport_category', opts.sportCategory)
  if (opts.minDistanceKm != null && opts.minDistanceKm > 0) params.set('min_distance_km', String(opts.minDistanceKm))
  const qs = params.toString()
  return fetchJSON<ActivitiesListResponse>(`/${user}/activities${qs ? `?${qs}` : ''}`)
}

/**
 * Fetch all activities matching the given date range, walking the server's
 * pagination automatically. The activities endpoint caps `limit` at 200
 * (`src/stride_server/routes/activities.py`), so callers that need a longer
 * window must paginate. Uses the API's `total` field as the termination
 * signal.
 */
export async function getAllActivities(
  user: string,
  opts: { dateFrom?: string; dateTo?: string } = {},
): Promise<Activity[]> {
  const PAGE = 200
  const all: Activity[] = []
  let offset = 0
  while (true) {
    const page = await getActivities(user, { ...opts, limit: PAGE, offset })
    all.push(...page.activities)
    if (page.activities.length === 0 || all.length >= page.total) break
    offset = all.length
  }
  return all
}

export async function getAllActivitiesInRange(
  user: string,
  opts: { dateFrom: string; dateTo?: string },
): Promise<Activity[]> {
  return getAllActivities(user, opts)
}

export function triggerSync(user: string, full: boolean = false) {
  const qs = full ? '?full=true' : ''
  return fetch(`${BASE}/${user}/sync${qs}`, { method: 'POST', headers: authHeaders() }).then(r => r.json()) as Promise<{ success: boolean; output?: string; error?: string }>
}

export function resyncActivity(user: string, labelId: string) {
  return fetch(`${BASE}/${user}/activities/${labelId}/resync`, { method: 'POST', headers: authHeaders() }).then(r => r.json()) as Promise<{ success: boolean; error?: string }>
}

export function regenerateCommentary(user: string, labelId: string) {
  return fetch(`${BASE}/${user}/activities/${labelId}/commentary/regenerate`, { method: 'POST', headers: authHeaders() })
    .then(r => r.json()) as Promise<{
      success: boolean
      commentary?: string
      generated_by?: string | null
      generated_at?: string | null
      error?: string
    }>
}

export interface TrainingPlanPhase {
  name: string
  start: string
  end: string
}

export interface TrainingPlan {
  content: string | null
  phases: TrainingPlanPhase[]
  current_phase: string | null
}

export function getTrainingPlan(user: string) {
  return fetchJSON<TrainingPlan>(`/${user}/training-plan`)
}

// ---------------------------------------------------------------------------
// Master Plan — active long-term plan adjustment
// ---------------------------------------------------------------------------

export interface MasterPlanMilestone {
  id: string
  type: string
  date: string
  phase_id: string
  target: string
  completed_actual: string | null
}

// One heart-rate zone's share of total in-zone time over a completed phase.
export interface HrZoneShare {
  zone_index: number
  minutes: number
  percent: number
}

// Deterministic "actual results" rollup for an already-completed phase (Q2a).
// Backend computes this once at generation time and caches it on the phase;
// snake_case to match the FastAPI model_dump() payload.
export interface CompletedPhaseSummary {
  total_distance_km: number
  run_count: number
  weekly_avg_km: number
  avg_pace_s_km: number | null
  avg_pace_fmt: string
  avg_hr: number | null
  hr_zone_distribution: HrZoneShare[]
}

export interface MasterPlanPhase {
  id: string
  name: string
  start_date: string
  end_date: string
  focus: string
  weekly_distance_km_low: number
  weekly_distance_km_high: number
  key_session_types: string[]
  milestone_ids: string[]
  // Phase type (base / build / peak / taper / race / recovery), used for the
  // overview color band + short-name mapping. Optional — older plans may omit.
  phase_type?: string
  // Editorial fields rendered on the S1 season overview for the selected
  // phase. Backend now ships these on every phase; treat as optional so
  // legacy plans that predate them still type-check.
  rhythm?: string                  // 阶段节奏
  key_workouts?: string            // 关键课型
  monitoring_triggers?: string[]   // 监控触发
  coach_note?: string              // 教练引言 (blockquote)
  // True for an already-completed leading phase (e.g. a finished base block
  // carried over from the prior plan). Kept on the timeline for continuity,
  // rendered dimmed + 「已完成」. Optional/false for every other phase.
  is_completed?: boolean
  // Deterministic actual-results rollup (Q2a). Present only on is_completed
  // phases; null/absent for active phases and legacy plans.
  summary?: CompletedPhaseSummary | null
}

export interface MasterPlanNextMilestone {
  id: string
  date: string
  target: string
  days_until: number
}

export interface MasterPlan {
  plan_id: string
  user_id: string
  status: string
  goal?: {
    goal_id: string
    race_name?: string
    distance?: string
    race_date?: string
    target_time?: string
    timezone?: string
    location?: string | null
  }
  start_date: string
  end_date: string
  phases: MasterPlanPhase[]
  milestones: MasterPlanMilestone[]
  training_principles: string[]
  generated_by: string
  version: number
  created_at: string
  updated_at: string
  current_phase_id: string | null
  current_week_number: number | null
  total_weeks: number | null
  next_milestone: MasterPlanNextMilestone | null
}

export interface MasterPlanDiffOp {
  id: string
  op: string
  phase_id: string | null
  milestone_id: string | null
  old_value: Record<string, unknown> | null
  new_value: Record<string, unknown> | null
  spec_patch: Record<string, unknown> | null
  accepted: boolean | null
}

export interface MasterPlanDiff {
  diff_id: string
  plan_id: string
  ops: MasterPlanDiffOp[]
  ai_explanation: string
  created_at: string
}

export interface MasterPlanAdjustMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface MasterPlanAdjustMessageResponse {
  ai_response: string
  diff: MasterPlanDiff | null
}

export interface MasterPlanAffectedWeek {
  folder: string
  reason: string
}

export interface MasterPlanAdjustApplyResponse {
  plan_id: string
  version: number
  updated_at: string
  applied: number
  affected_weeks: MasterPlanAffectedWeek[]
}

export async function getCurrentMasterPlan(): Promise<MasterPlan | null> {
  // Route through apiFetch so the 401→refresh→retry path + header/init shape
  // match every other GET client (and the api.activities test contract).
  // 404 means "no active plan" → null (not an error); other !ok still throws.
  const res = await apiFetch('GET', '/users/me/master-plan/current')
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function getDraftMasterPlan(): Promise<MasterPlan | null> {
  const res = await apiFetch('GET', '/users/me/master-plan/draft')
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function getMasterPlanById(planId: string): Promise<MasterPlan> {
  const res = await apiFetch('GET', `/users/me/master-plan/${encodeURIComponent(planId)}`)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export function sendMasterPlanReviewMessage(
  planId: string,
  message: string,
  history: MasterPlanAdjustMessage[] = [],
) {
  return postJSON<MasterPlanAdjustMessageResponse>(
    `/users/me/master-plan/${encodeURIComponent(planId)}/review/messages`,
    { message, history },
  )
}

export interface MasterPlanReviewApplyResponse {
  plan_id: string
  version: number
  updated_at: string
  applied: number
}

export function applyMasterPlanReviewDiff(
  planId: string,
  diff: MasterPlanDiff,
  acceptedOpIds: string[],
  changeReason: string,
) {
  return postJSON<MasterPlanReviewApplyResponse>(
    `/users/me/master-plan/${encodeURIComponent(planId)}/review/apply`,
    {
      diff,
      accepted_op_ids: acceptedOpIds,
      change_reason: changeReason,
    },
  )
}

export function sendMasterPlanAdjustMessage(
  planId: string,
  message: string,
  history: MasterPlanAdjustMessage[] = [],
) {
  return postJSON<MasterPlanAdjustMessageResponse>(
    `/users/me/master-plan/${encodeURIComponent(planId)}/adjust/messages`,
    { message, history },
  )
}

export function applyMasterPlanAdjustDiff(
  planId: string,
  diffId: string,
  acceptedOpIds: string[],
  changeReason: string,
) {
  return postJSON<MasterPlanAdjustApplyResponse>(
    `/users/me/master-plan/${encodeURIComponent(planId)}/adjust/apply`,
    {
      diff_id: diffId,
      accepted_op_ids: acceptedOpIds,
      change_reason: changeReason,
    },
  )
}

// ---------------------------------------------------------------------------
// S1 season-plan generation — training goal → generate → poll → confirm
// ---------------------------------------------------------------------------

export type RaceDistance = '5K' | '10K' | 'HM' | 'FM' | 'trail'
export type WeeklyTrainingDays = 3 | 4 | 5 | 6

export interface TrainingGoalInput {
  type: 'race'
  race_distance: RaceDistance
  race_name: string
  race_date: string                       // YYYY-MM-DD
  // null = 仅完赛即可 (finish-only). Omit string fields the backend marked
  // optional (available_time_slots / strength_willingness).
  target_finish_time?: string | null
  weekly_training_days: WeeklyTrainingDays
}

export interface TrainingGoal extends TrainingGoalInput {
  goal_id?: string
  id?: string
  created_at?: string
  updated_at?: string
}

export function createTrainingGoal(goal: TrainingGoalInput) {
  return postJSON<TrainingGoal & { error?: string; detail?: unknown }>(
    '/users/me/training-goal',
    goal,
  )
}

/** Current training goal, or null when none is set (404). */
export async function getTrainingGoal(): Promise<TrainingGoal | null> {
  const res = await apiFetch('GET', '/users/me/training-goal')
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export interface GenerateMasterPlanResponse {
  job_id: string
  status: string
  eta_seconds: number
}

export function generateMasterPlan(goalId?: string) {
  return postJSON<GenerateMasterPlanResponse & { error?: string; detail?: unknown }>(
    '/users/me/master-plan/generate',
    goalId ? { goal_id: goalId } : {},
  )
}

export type MasterPlanJobStatus = 'queued' | 'running' | 'done' | 'failed'
export type MasterPlanJobStage =
  | 'reading_history'
  | 'evaluating'
  | 'planning_phases'
  | 'rule_filter'
  | 'outputting'

export interface MasterPlanJobContext {
  avg_weekly_km?: number
  max_weekly_km?: number
  weeks_to_race?: number
  chronic_load?: number
  acute_load?: number
  form?: number
  fitness_summary?: string
}

export interface MasterPlanJob {
  status: MasterPlanJobStatus
  stage: MasterPlanJobStage | null
  progress: number                        // 0-100
  stage_label: string
  context: MasterPlanJobContext | null
  result_plan_id: string | null
  error: string | null
}

export function getMasterPlanJob(jobId: string) {
  return fetchJSON<MasterPlanJob>(
    `/users/me/master-plan/jobs/${encodeURIComponent(jobId)}`,
  )
}

/** Promote a DRAFT plan to ACTIVE; returns the promoted plan. */
export function confirmMasterPlan(planId: string) {
  return postJSON<MasterPlan & { error?: string; detail?: unknown }>(
    `/users/me/master-plan/${encodeURIComponent(planId)}/confirm`,
  )
}

export interface HealthRecord {
  date: string
  ati: number | null
  cti: number | null
  rhr: number | null
  distance_m: number | null
  duration_s: number | null
  training_load_ratio: number | null
  training_load_state: string | null
  fatigue: number | null
  // Phase 3 Garmin extras (NULL for COROS rows)
  body_battery_high: number | null
  body_battery_low: number | null
  stress_avg: number | null
  sleep_total_s: number | null
  sleep_deep_s: number | null
  sleep_light_s: number | null
  sleep_rem_s: number | null
  sleep_awake_s: number | null
  sleep_score: number | null
  respiration_avg: number | null
  spo2_avg: number | null
  provider: string | null
}

export interface HrvTrendPoint {
  date: string
  last_night_avg: number | null
  status: string | null
  // Per-day watch-reported balanced band — distinct from the user-level
  // `hrv_normal_low/high` snapshot on HRVSnapshot (which is a stable
  // baseline range, while these drift day by day).
  daily_balanced_low: number | null
  daily_balanced_upper: number | null
}

export interface HRVSnapshot {
  avg_sleep_hrv: number | null
  hrv_normal_low: number | null
  hrv_normal_high: number | null
  recovery_pct: number | null
  trend: HrvTrendPoint[]
  // Date of the most recent daily_hrv reading. The `avg_sleep_hrv` value is
  // a dashboard snapshot with no date of its own; this is the closest "as-of"
  // the server can attach. Null until the user has any daily_hrv rows.
  date: string | null
}

export function getHealth(user: string, days = 30) {
  return fetchJSON<{ health: HealthRecord[]; hrv: HRVSnapshot; rhr_baseline: number | null }>(`/${user}/health?days=${days}`)
}

export interface HrvDailyRecord {
  date: string
  weekly_avg: number | null
  last_night_avg: number | null
  last_night_5min_high: number | null
  status: string | null
  baseline_low_upper: number | null
  // Per-day watch-reported balanced band — see HrvTrendPoint for the same
  // semantics on /api/health. Named `daily_*` not `baseline_*` so callers
  // don't conflate this with `hrv_normal_*` on HRVSnapshot (which is the
  // user-level baseline range, not a per-day threshold).
  daily_balanced_low: number | null
  daily_balanced_upper: number | null
  feedback_phrase: string | null
  provider: string | null
}

export interface HrvSummary {
  date: string | null
  last_night_avg: number | null
  weekly_avg: number | null
  status: string | null
  daily_balanced_low: number | null
  daily_balanced_upper: number | null
}

export function getHrv(user: string, days = 30) {
  return fetchJSON<{ hrv: HrvDailyRecord[]; summary: HrvSummary }>(`/${user}/hrv?days=${days}`)
}

export interface PMCRecord {
  date: string
  ati: number | null
  cti: number | null
  rhr: number | null
  fatigue: number | null
  training_load_ratio: number | null
  training_load_state: string | null
  tsb: number
  tsb_zone: string
  tsb_zone_label: string
  ctl_ramp: number | null
}

export interface PMCSummary {
  current_cti: number | null
  current_ati: number | null
  current_tsb: number | null
  current_tsb_zone: string | null
  current_tsb_zone_label: string | null
  current_fatigue: number | null
  current_rhr: number | null
  ctl_ramp: number | null
  date: string | null
}

export interface StridePMCRecord {
  date: string
  algorithm_version: number
  training_dose: number | null
  acute_load: number | null
  chronic_load: number | null
  form: number | null
  load_ratio: number | null
  readiness_gate: string | null
  readiness_reasons: string[]
  chronic_load_ramp: number | null
}

export interface StridePMCSummary {
  date: string | null
  current_training_dose: number | null
  current_acute_load: number | null
  current_chronic_load: number | null
  current_form: number | null
  current_load_ratio: number | null
  current_readiness_gate: string | null
  current_readiness_reasons: string[] | null
  chronic_load_ramp: number | null
}

export function getPMC(user: string, days = 90) {
  return fetchJSON<{
    pmc: PMCRecord[]
    summary: PMCSummary
    stride_pmc?: StridePMCRecord[]
    stride_summary?: StridePMCSummary
  }>(`/${user}/pmc?days=${days}`)
}

export interface BodyCompositionSegment {
  segment: 'left_arm' | 'right_arm' | 'trunk' | 'left_leg' | 'right_leg'
  lean_mass_kg: number
  fat_mass_kg: number
  lean_pct_of_standard: number | null
  fat_pct_of_standard: number | null
}

export interface BodyCompositionScan {
  scan_date: string
  jpg_path: string | null
  weight_kg: number
  body_fat_pct: number
  smm_kg: number
  fat_mass_kg: number
  visceral_fat_level: number
  bmr_kcal: number | null
  protein_kg: number | null
  water_l: number | null
  smi: number | null
  inbody_score: number | null   // brand-specific reading kept verbatim
  ingested_at: string
  // Derived
  leg_smm_delta: number | null
  leg_fat_delta: number | null
  arm_smm_delta: number | null
  upper_lower_smm_ratio: number | null
  left_arm_smm_kg: number | null
  right_arm_smm_kg: number | null
  trunk_smm_kg: number | null
  left_leg_smm_kg: number | null
  right_leg_smm_kg: number | null
  left_arm_fat_kg: number | null
  right_arm_fat_kg: number | null
  trunk_fat_kg: number | null
  left_leg_fat_kg: number | null
  right_leg_fat_kg: number | null
  left_arm_lean_pct_std: number | null
  right_arm_lean_pct_std: number | null
  trunk_lean_pct_std: number | null
  left_leg_lean_pct_std: number | null
  right_leg_lean_pct_std: number | null
  left_arm_fat_pct_std: number | null
  right_arm_fat_pct_std: number | null
  trunk_fat_pct_std: number | null
  left_leg_fat_pct_std: number | null
  right_leg_fat_pct_std: number | null
  segments?: BodyCompositionSegment[]
}

export interface BodyCompositionCheckpoint {
  phase: string
  date: string
  weight_kg: number
  body_fat_pct: number
  smm_kg_min: number
}

export interface BodyCompositionDeltas {
  prev_date: string
  weight_kg: number
  body_fat_pct: number
  smm_kg: number
  fat_mass_kg: number
  visceral_fat_level: number
}

export interface BodyCompositionSummary {
  latest: BodyCompositionScan | null
  deltas: BodyCompositionDeltas | null
  checkpoints: BodyCompositionCheckpoint[]
}

export function getBodyComposition(user: string, days?: number) {
  const qs = days ? `?days=${days}` : ''
  return fetchJSON<{ scans: BodyCompositionScan[] }>(`/${user}/body-composition${qs}`)
}

export function getBodyCompositionSummary(user: string) {
  return fetchJSON<BodyCompositionSummary>(`/${user}/body-composition/summary`)
}

export function getBodyCompositionScan(user: string, scanDate: string) {
  return fetchJSON<BodyCompositionScan>(`/${user}/body-composition/${scanDate}`)
}

export type BodyCompositionScanInput = {
  scan_date: string
  weight_kg: number
  body_fat_pct: number
  smm_kg: number
  fat_mass_kg: number
  visceral_fat_level: number
  bmr_kcal?: number | null
  protein_kg?: number | null
  water_l?: number | null
  smi?: number | null
  inbody_score?: number | null
  segments?: Array<{
    segment: 'left_arm' | 'right_arm' | 'trunk' | 'left_leg' | 'right_leg'
    lean_mass_kg: number
    fat_mass_kg: number
    lean_pct_of_standard?: number | null
    fat_pct_of_standard?: number | null
  }>
}

export function upsertBodyComposition(user: string, payload: BodyCompositionScanInput): Promise<{ ok: boolean; status: number; data: BodyCompositionScan }> {
  return postJSON<BodyCompositionScan>(`/${user}/body-composition`, payload)
}

export function getWeeks(user: string) {
  return fetchJSON<{ weeks: WeekSummary[] }>(`/${user}/weeks`)
}

// ---------------------------------------------------------------------------
// Ability (4-layer custom running score)
// ---------------------------------------------------------------------------

export interface RaceEstimates {
  training_s: number | null
  race_s: number | null
  best_case_s: number | null
  race_day_boost_pct?: number
  best_case_boost_pct?: number
}

/** @deprecated Use RaceEstimates — kept for backward compat */
export type MarathonEstimates = RaceEstimates

export interface L3Dimension {
  score: number | null
  evidence: string[]
  // Live-computed snapshots spread extra diagnostic fields (vo2max_primary, etc.)
  [key: string]: unknown
}

export interface AbilityCurrent {
  date: string
  source: 'snapshot' | 'computed'
  l2_freshness: { total: number | null } | { total: number; breakdown?: Record<string, number> } | null
  l3_dimensions: {
    aerobic: L3Dimension
    lt: L3Dimension
    vo2max: L3Dimension
    endurance: L3Dimension
    economy: L3Dimension
    recovery: L3Dimension
  }
  l4_composite: number | null
  l4_marathon_estimate_s: number | null
  distance_to_sub_2_50_s: number | null
  distance_to_target_s?: number | null
  // Target info — HM or FM.
  target_distance?: 'HM' | 'FM'
  target_s?: number | null
  target_label?: string | null
  // Backward compat marathon target fields.
  marathon_target_s?: number | null
  marathon_target_label?: string | null
  marathon_estimates: RaceEstimates
  half_marathon_estimates?: RaceEstimates
  evidence_activity_ids: string[]
}

export interface AbilityHistoryPoint {
  date: string
  l4_composite: number | null
  l4_marathon_race_s: number | null
  l4_hm_race_s?: number | null
  l3: {
    aerobic: number | null
    lt: number | null
    vo2max: number | null
    endurance: number | null
    economy: number | null
    recovery: number | null
  }
}

export interface ActivityAbility {
  label_id: string
  l1_quality: number | null
  l1_breakdown: Record<string, number>
  contribution: Record<string, number>
  computed_at: string | null
}

export interface AbilityWeights {
  l4_weights: Record<string, number>
}

export interface PBHistoryPoint {
  date: string
  best_so_far_sec: number
  label_id: string | null
  source: string | null
  segment_start_s: number | null
  segment_end_s: number | null
}

export interface PBEntry {
  distance: string            // "1K" | "3K" | "5K" | "10K" | "HM" | "FM"
  race_type: string | null
  pb_time_sec: number
  achieved_at: string         // Shanghai YYYY-MM-DD
  label_id: string
  name: string | null
  source: string | null
  segment_start_s: number | null
  segment_end_s: number | null
  history: PBHistoryPoint[]
}

export interface PBsResponse {
  user_id: string
  computed_at: string
  pbs: PBEntry[]
}

export function fetchPbs(user: string) {
  return fetchJSON<PBsResponse>(`/${user}/pbs`)
}

export function fetchAbilityCurrent(user: string, refresh = false) {
  const qs = refresh ? '?refresh=1' : ''
  return fetchJSON<AbilityCurrent>(`/${user}/ability/current${qs}`)
}

export function fetchAbilityHistory(user: string, days = 90) {
  return fetchJSON<AbilityHistoryPoint[]>(`/${user}/ability/history?days=${days}`)
}

export async function triggerAbilityBackfill(user: string, days = 180) {
  const res = await fetch(`${BASE}/${user}/ability/backfill?days=${days}`, {
    method: 'POST',
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(`backfill failed: ${res.status}`)
  return res.json() as Promise<{ days_requested: number; written: number; skipped: number }>
}

export function fetchAbilityWeights(user: string) {
  return fetchJSON<AbilityWeights>(`/${user}/ability/weights`)
}

export function fetchActivityAbility(user: string, labelId: string) {
  return fetchJSON<ActivityAbility>(`/${user}/activities/${labelId}/ability`)
}

// ---------------------------------------------------------------------------
// Teams (proxied to auth-service for membership; cross-user feed served by STRIDE)
// ---------------------------------------------------------------------------

export interface Team {
  id: string
  name: string
  description?: string | null
  owner_user_id: string
  is_open: boolean
  member_count?: number
  created_at?: string
}

export interface TeamMember {
  user_id: string
  name?: string | null
  display_name?: string | null
  email?: string | null
  role: string
  joined_at?: string
}

export interface MyTeam {
  id: string
  name: string
  role: string
  joined_at?: string
}

export interface TeamFeedActivity extends Activity {
  user_id: string
  display_name: string
  like_count?: number
  you_liked?: boolean
  top_likers?: string[]
}

export interface ActivityLiker {
  user_id: string
  display_name: string
  created_at: string
}

export interface ActivityLikes {
  count: number
  you_liked: boolean
  likers: ActivityLiker[]
}

export interface ActivityLikeMutation {
  liked: boolean
  count: number
  you_liked: boolean
}

export interface TeamFeed {
  team_id: string
  member_count: number
  activities: TeamFeedActivity[]
}

export function listTeams() {
  return fetchJSON<{ teams: Team[] }>('/teams')
}

export function getTeam(id: string) {
  return fetchJSON<Team>(`/teams/${id}`)
}

export function createTeam(payload: { name: string; description?: string }) {
  return postJSON<Team>('/teams', payload)
}

export function joinTeam(id: string) {
  return postJSON<Record<string, unknown>>(`/teams/${id}/join`)
}

export function leaveTeam(id: string) {
  return postJSON<Record<string, unknown>>(`/teams/${id}/leave`)
}

export function transferTeamOwner(id: string, newOwnerUserId: string) {
  return postJSON<Team>(`/teams/${id}/transfer-owner`, { new_owner_user_id: newOwnerUserId })
}

export function deleteTeam(id: string) {
  return deleteJSON<Record<string, unknown>>(`/teams/${id}`)
}

export function getTeamMembers(id: string) {
  return fetchJSON<{ members: TeamMember[] }>(`/teams/${id}/members`)
}

export function getTeamFeed(id: string, days = 30) {
  return fetchJSON<TeamFeed>(`/teams/${id}/feed?days=${days}`)
}

export type MileagePeriod = 'month' | 'week'

export interface MileageRankingEntry {
  user_id: string
  display_name: string
  total_km: number
  activity_count: number
}

export interface MileageLeaderboardData {
  team_id: string
  period: MileagePeriod
  period_start: string
  period_end: string
  rankings: MileageRankingEntry[]
}

export function getTeamMileage(id: string, period: MileagePeriod = 'month') {
  return fetchJSON<MileageLeaderboardData>(`/teams/${id}/mileage?period=${period}`)
}

export function getActivityLikes(teamId: string, userId: string, labelId: string) {
  return fetchJSON<ActivityLikes>(
    `/teams/${teamId}/activities/${userId}/${labelId}/likes`,
  )
}

export function likeActivity(teamId: string, userId: string, labelId: string) {
  return postJSON<ActivityLikeMutation>(
    `/teams/${teamId}/activities/${userId}/${labelId}/likes`,
  )
}

export function unlikeActivity(teamId: string, userId: string, labelId: string) {
  return deleteJSON<ActivityLikeMutation>(
    `/teams/${teamId}/activities/${userId}/${labelId}/likes`,
  )
}

export function listMyTeams() {
  return fetchJSON<{ teams: MyTeam[] }>('/users/me/teams')
}

export interface TeamSyncMemberResult {
  user_id: string
  display_name: string
  status: 'synced' | 'skipped_no_auth' | 'error'
  new_activities: number
  new_health: number
  error: string | null
}

export interface TeamSyncTotals {
  members: number
  synced: number
  skipped: number
  errors: number
  new_activities: number
  new_health: number
}

export interface TeamSyncSummary {
  team_id: string
  results: TeamSyncMemberResult[]
  totals: TeamSyncTotals
}

export function syncTeamAll(id: string) {
  return postJSON<TeamSyncSummary>(`/teams/${id}/sync-all`)
}

export function getWeek(user: string, folder: string) {
  return fetchJSON<WeekDetail>(`/${user}/weeks/${folder}`)
}

export function getWeekStrength(user: string, folder: string) {
  return fetchJSON<import('./types/strength').StrengthTabResponse>(
    `/${user}/weeks/${folder}/strength`,
  )
}

// ---------------------------------------------------------------------------
// Plan API — structured weekly-plan calendar / push / reparse
// ---------------------------------------------------------------------------

/**
 * Server response is a superset of the local `PlannedSession` schema:
 *   - `id` is the DB primary key (the `(date, session_index)` pair we use
 *     in the push URL is path data, while `id` is convenient for React keys).
 *   - `pushable` is server-derived (kind in {RUN, STRENGTH} && spec != null).
 */
export interface PlannedSessionRow extends PlannedSession {
  id: number
  pushable: boolean
}

export interface PlanDay {
  date: string
  sessions: PlannedSessionRow[]
  nutrition: PlannedNutrition | null
}

export interface PlanDaysResponse {
  days: PlanDay[]
}

export interface PlanTodayResponse {
  date: string
  sessions: PlannedSessionRow[]
  nutrition: PlannedNutrition | null
  planned_vs_actual: Array<{ planned: PlannedSessionRow; actual: Activity | null }>
}

export interface PushPlannedSessionResponse {
  ok: boolean
  planned_session_id?: number
  scheduled_workout_id?: number
  provider?: string
  provider_workout_id?: string
  /** Actual ISO date the workout was scheduled to on the watch. Equals the
   *  planned date when no `target_date` override was supplied. */
  push_date?: string
  // 409 carries the actual structured_status so the UI can show the right hint.
  detail?: { error?: string; structured_status?: StructuredStatus | null } | string
}

export interface ReparsePlanResponse {
  ok: boolean
  folder: string
  structured_status: StructuredStatus
  parse_error: string | null
}

export interface WeeklyPlanStructuredResponse {
  structured_status: StructuredStatus
  structured_parsed_at: string | null
  sessions: PlannedSessionRow[]
  nutrition: PlannedNutrition[]
}

export function getPlanDays(user: string, from: string, to: string) {
  const qs = new URLSearchParams({ from, to }).toString()
  return fetchJSON<PlanDaysResponse>(`/${user}/plan/days?${qs}`)
}

export function getPlanToday(user: string) {
  return fetchJSON<PlanTodayResponse>(`/${user}/plan/today`)
}

export function pushPlannedSession(
  user: string,
  date: string,
  sessionIndex: number,
  targetDate?: string,
) {
  const path = `/${user}/plan/sessions/${date}/${sessionIndex}/push`
  const qs = targetDate ? `?${new URLSearchParams({ target_date: targetDate }).toString()}` : ''
  return postJSON<PushPlannedSessionResponse>(`${path}${qs}`)
}

export function reparsePlan(user: string, folder: string) {
  const qs = new URLSearchParams({ folder }).toString()
  return postJSON<ReparsePlanResponse>(`/${user}/plan/reparse?${qs}`)
}

export function updateWeeklyFeedback(user: string, folder: string, content: string, generatedBy?: string) {
  return putJSON<{
    success: boolean
    week: string
    feedback_source: string
    feedback_updated_at?: string | null
    feedback_generated_by?: string | null
  }>(`/${user}/weeks/${folder}/feedback`, {
    content,
    generated_by: generatedBy,
  })
}

export interface Segment extends Lap {
  seg_name: string
  mode: number | null
}

export interface LinkedScheduledWorkout {
  id: number
  abandoned_by_promote_at: string | null
}

export interface ActivityStrideTrainingLoad {
  label_id: string
  activity_date: string
  sport: string | null
  session_class: string | null
  algorithm_version: number
  calibration_id: number | null
  cardio_load_raw: number | null
  cardio_tss: number | null
  external_tss: number | null
  mechanical_load: number | null
  subjective_internal_load: number | null
  training_dose: number | null
  load_confidence: string | null
  excluded_from_pmc: boolean
  reasons: string[]
}

export interface ActivityDetailResponse {
  activity: Activity
  stride_training_load?: ActivityStrideTrainingLoad | null
  laps: Lap[]
  segments: Segment[]
  zones: Zone[]
  timeseries: TimeseriesPoint[]
  linked_scheduled_workout?: LinkedScheduledWorkout | null
}

export function getActivity(user: string, id: string) {
  return fetchJSON<ActivityDetailResponse>(
    `/${user}/activities/${id}?include=timeseries`
  )
}

export function getTeamActivity(teamId: string, userId: string, labelId: string) {
  return fetchJSON<ActivityDetailResponse>(
    `/teams/${teamId}/activities/${userId}/${labelId}`
  )
}

// All date / time formatters route through the canonical Asia/Shanghai
// helpers in `./lib/shanghai`. They pin every conversion to Asia/Shanghai so
// the dashboard renders the same calendar day whether it's opened in
// Beijing or Berlin. Never reintroduce `d.getMonth()` / `d.getDate()` math
// here — those use browser-local TZ and quietly drift abroad.
import {
  shanghaiDate as _shanghaiDate,
  shanghaiMonthDay as _shanghaiMonthDay,
  shanghaiTime as _shanghaiTime,
} from './lib/shanghai'

export function formatDate(dateStr: string): string {
  return _shanghaiDate(dateStr) || dateStr
}

export function formatDateShort(dateStr: string): string {
  const md = _shanghaiMonthDay(dateStr)
  if (!md) return dateStr
  const [m, d] = md.split('-')
  return `${parseInt(m, 10)}月${parseInt(d, 10)}日`
}

export function formatTime(dateStr: string): string {
  return _shanghaiTime(dateStr)
}

export function formatWeekRange(dateFrom: string, dateTo: string): string {
  const from = _shanghaiMonthDay(dateFrom)
  const to = _shanghaiMonthDay(dateTo)
  if (!from || !to) return `${dateFrom} — ${dateTo}`
  const [fm, fd] = from.split('-')
  const [tm, td] = to.split('-')
  return `${parseInt(fm, 10)}/${parseInt(fd, 10)} — ${parseInt(tm, 10)}/${parseInt(td, 10)}`
}

const SPORT_CN: Record<string, string> = {
  'Run': '跑步',
  'Indoor Run': '室内跑',
  'Trail Run': '越野跑',
  'Track Run': '田径场跑',
  'Treadmill': '跑步机',
  'Strength Training': '力量训练',
  'Strength': '力量训练',
  'Walk': '步行',
  'Hike': '徒步',
  'Bike': '骑行',
  'Swim (Pool)': '泳池游泳',
  'Swim (Open Water)': '开放水域',
}

const TRAIN_TYPE_CN: Record<string, string> = {
  'Base': '基础',
  'Aerobic Endurance': '有氧耐力',
  'Threshold': '乳酸阈',
  'Interval': '间歇',
  'VO2 Max': '最大摄氧',
  'Anaerobic': '无氧',
  'Sprint': '冲刺',
  'Recovery': '恢复',
}

export function sportNameCN(name: string): string {
  return SPORT_CN[name] || name
}

export function trainTypeCN(type: string | null): string {
  if (!type) return ''
  return TRAIN_TYPE_CN[type] || type
}

export function sportColor(sportName: string): string {
  const colors: Record<string, string> = {
    'Run': '#00e676',
    'Indoor Run': '#00e5ff',
    'Trail Run': '#ffab00',
    'Track Run': '#b388ff',
    'Strength Training': '#ff6d00',
    'Strength': '#ff6d00',
    'Walk': '#64dd17',
    'Hike': '#64dd17',
  }
  return colors[sportName] || '#8888a0'
}

export function trainTypeColor(trainType: string | null): string {
  if (!trainType) return '#555570'
  const colors: Record<string, string> = {
    'Base': '#64dd17',
    'Aerobic Endurance': '#00e676',
    'Threshold': '#ffab00',
    'Interval': '#ff6d00',
    'VO2 Max': '#ff1744',
    'Anaerobic': '#ff5252',
    'Sprint': '#ff1744',
    'Recovery': '#00e5ff',
  }
  return colors[trainType] || '#8888a0'
}

// Re-export from the canonical helper. Pinned to Asia/Shanghai so the
// weekday label matches the date label, even abroad.
export { shanghaiWeekday as weekdayCN } from './lib/shanghai'

// ─────────────────────────────────────────────────────────────────────────────
// Multi-variant plans (Step 4)
// ─────────────────────────────────────────────────────────────────────────────

import type {
  PlanVariant,
  RatingDimension,
  RatingScore,
  VariantsResponse,
} from './types/plan'

export function getPlanVariants(
  user: string,
  folder: string,
  includeSuperseded: boolean = false,
): Promise<VariantsResponse> {
  const qs = includeSuperseded ? '?include_superseded=true' : ''
  return fetchJSON<VariantsResponse>(
    `/${user}/plan/${encodeURIComponent(folder)}/variants${qs}`,
  )
}

export async function ratePlanVariant(
  user: string,
  variantId: number,
  ratings: Partial<Record<RatingDimension, RatingScore>>,
  comment?: string | null,
): Promise<{ ratings: Partial<Record<RatingDimension, RatingScore>>; rating_comment: string | null }> {
  const body: Record<string, unknown> = { ratings }
  if (comment !== undefined && comment !== null) body.comment = comment
  const res = await postJSON<{ ratings: Partial<Record<RatingDimension, RatingScore>>; rating_comment: string | null }>(
    `/${user}/plan/variants/${variantId}/rate`,
    body,
  )
  if (!res.ok) {
    throw new Error(`rate failed: HTTP ${res.status}`)
  }
  return res.data
}

export interface SelectVariantSuccess {
  ok: true
  no_change?: boolean
  week_folder: string
  selected_variant_id: number
  dropped_scheduled_workout_ids: number[]
}

export interface SelectVariantConflict {
  status: 409
  error: 'selection_conflict' | 'concurrent_select'
  already_pushed_count?: number
  hint?: string
}

export interface SelectVariantSchemaOutdated {
  status: 426
  error: 'variant_schema_outdated'
  variant_version?: number
  server_version?: number
}

export type SelectVariantError = SelectVariantConflict | SelectVariantSchemaOutdated

/** Promote a variant to canonical. Auto-retries once on
 * 409 concurrent_select with `Retry-After: 1`; surfaces
 * `selection_conflict` (force=false with prior pushes) and 426
 * `variant_schema_outdated` as typed errors via the rejected promise.
 */
export async function selectPlanVariant(
  user: string,
  folder: string,
  variantId: number,
  force: boolean = false,
): Promise<SelectVariantSuccess> {
  const path = `/${user}/plan/${encodeURIComponent(folder)}/select`
  const body = { variant_id: variantId, force }

  const doPost = async () => postJSON<{ detail?: { error?: string; already_pushed_count?: number; hint?: string; variant_version?: number; server_version?: number }; ok?: boolean; no_change?: boolean; week_folder?: string; selected_variant_id?: number; dropped_scheduled_workout_ids?: number[] }>(path, body)

  let res = await doPost()

  // Auto-retry once on concurrent_select 409.
  if (res.status === 409 && res.data?.detail?.error === 'concurrent_select') {
    await new Promise(resolve => setTimeout(resolve, 1000))
    res = await doPost()
  }

  if (res.ok) {
    return {
      ok: true,
      no_change: res.data?.no_change ?? false,
      week_folder: res.data?.week_folder ?? folder,
      selected_variant_id: res.data?.selected_variant_id ?? variantId,
      dropped_scheduled_workout_ids: res.data?.dropped_scheduled_workout_ids ?? [],
    }
  }

  const detail = res.data?.detail ?? {}
  if (res.status === 409) {
    const err: SelectVariantConflict = {
      status: 409,
      error: (detail.error === 'concurrent_select' ? 'concurrent_select' : 'selection_conflict'),
      already_pushed_count: detail.already_pushed_count,
      hint: detail.hint,
    }
    throw err
  }
  if (res.status === 426) {
    const err: SelectVariantSchemaOutdated = {
      status: 426,
      error: 'variant_schema_outdated',
      variant_version: detail.variant_version,
      server_version: detail.server_version,
    }
    throw err
  }
  throw new Error(`select failed: HTTP ${res.status}`)
}

export async function deletePlanVariants(
  user: string,
  folder: string,
): Promise<{ deleted_variants: number }> {
  const res = await deleteJSON<{ deleted_variants: number }>(
    `/${user}/plan/${encodeURIComponent(folder)}/variants`,
  )
  if (!res.ok) {
    throw new Error(`delete variants failed: HTTP ${res.status}`)
  }
  return res.data
}

/** Helper used by VariantComparisonView — sums total_distance_m across
 * run sessions and converts to km (rounded to 1 decimal). */
export function totalRunKm(variant: PlanVariant): number {
  const m = variant.sessions
    .filter(s => s.kind === 'run' && typeof s.total_distance_m === 'number')
    .reduce((sum, s) => sum + (s.total_distance_m ?? 0), 0)
  return Math.round(m / 100) / 10
}

/** Helper — total kcal target across all days in this variant. */
export function totalKcalTarget(variant: PlanVariant): number {
  return variant.nutrition.reduce((sum, n) => sum + (n.kcal_target ?? 0), 0)
}

/** Helper — average overall rating, or null if no overall rating yet. */
export function overallRating(variant: PlanVariant): RatingScore | null {
  const v = variant.ratings.overall
  return typeof v === 'number' ? (v as RatingScore) : null
}

// =============================================================
// STRIDE self-developed endpoints (/api/{user}/stride/*)
// =============================================================

export interface StrideThreshold {
  speed_mps: number | null
  pace_per_km_sec: number | null
  hr_bpm: number | null
  speed_confidence: string | null
  hr_confidence: string | null
  as_of_date: string
  calibration_id: number
}

export interface StridePaceZone {
  name: string             // 'Z1' | 'Z2' | 'Z3' | 'Z4' | 'Z5'
  label: string            // '轻松' / '有氧' / ...
  lower_pace: string | null  // 'M:SS' /km (slower edge)
  upper_pace: string | null  // 'M:SS' /km (faster edge)
}

export interface StrideHrZone {
  name: string
  label: string
  lower_bpm: number | null
  upper_bpm: number | null
}

export interface StrideZonesResponse {
  threshold: StrideThreshold | null
  pace_zones: StridePaceZone[]
  hr_zones: StrideHrZone[]
}

export function getStrideZones(user: string) {
  return fetchJSON<StrideZonesResponse>(`/${user}/stride/zones`)
}

export interface StrideTrainingLoadRecord {
  date: string
  algorithm_version: number
  training_dose: number | null
  acute_load: number | null
  chronic_load: number | null
  form: number | null
  load_ratio: number | null
  readiness_gate: string | null
  readiness_reasons: string[]
}

export interface StrideTrainingLoadResponse {
  current: StrideTrainingLoadRecord | null
  series: StrideTrainingLoadRecord[]
}

export function getStrideTrainingLoad(user: string, days = 90) {
  return fetchJSON<StrideTrainingLoadResponse>(`/${user}/stride/training-load?days=${days}`)
}
