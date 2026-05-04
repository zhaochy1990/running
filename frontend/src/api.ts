import { refreshAccessToken } from './store/authStore'
import type {
  AbandonedScheduledWorkout,
  PlannedNutrition,
  PlannedSession,
  StructuredStatus,
  VariantsSummary,
} from './types/plan'

const BASE = '/api'

function authHeaders(): HeadersInit {
  const token = sessionStorage.getItem('access_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function fetchJSON<T>(path: string): Promise<T> {
  let res = await fetch(`${BASE}${path}`, { headers: authHeaders() })

  // Auto-refresh on 401
  if (res.status === 401) {
    try {
      await refreshAccessToken()
      res = await fetch(`${BASE}${path}`, { headers: authHeaders() })
    } catch {
      sessionStorage.clear()
      window.location.href = '/login'
      throw new Error('Session expired')
    }
  }

  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

async function postJSON<T>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  let res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (res.status === 401) {
    try {
      await refreshAccessToken()
      res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch {
      sessionStorage.clear()
      window.location.href = '/login'
      throw new Error('Session expired')
    }
  }

  const data = await res.json().catch(() => ({} as T))
  return { ok: res.ok, status: res.status, data: data as T }
}

async function putJSON<T>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  let res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (res.status === 401) {
    try {
      await refreshAccessToken()
      res = await fetch(`${BASE}${path}`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch {
      sessionStorage.clear()
      window.location.href = '/login'
      throw new Error('Session expired')
    }
  }

  const data = await res.json().catch(() => ({} as T))
  return { ok: res.ok, status: res.status, data: data as T }
}

async function patchJSON<T>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  let res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (res.status === 401) {
    try {
      await refreshAccessToken()
      res = await fetch(`${BASE}${path}`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch {
      sessionStorage.clear()
      window.location.href = '/login'
      throw new Error('Session expired')
    }
  }

  const data = await res.json().catch(() => ({} as T))
  return { ok: res.ok, status: res.status, data: data as T }
}

async function deleteJSON<T>(path: string): Promise<{ ok: boolean; status: number; data: T }> {
  let res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })

  if (res.status === 401) {
    try {
      await refreshAccessToken()
      res = await fetch(`${BASE}${path}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
    } catch {
      sessionStorage.clear()
      window.location.href = '/login'
      throw new Error('Session expired')
    }
  }

  const data = await res.json().catch(() => ({} as T))
  return { ok: res.ok, status: res.status, data: data as T }
}

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
  target_race: string
  target_distance: TargetDistance
  target_race_date: string
  target_time: string
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
}

export interface WeekSummary {
  folder: string
  date_from: string
  date_to: string
  has_plan: boolean
  has_feedback: boolean
  has_inbody: boolean
  plan_title?: string
  activity_count: number
  total_km: number
  total_duration_s: number
  total_duration_fmt: string
}

export interface IntensitySummary {
  total_run_km: number
  low_km: number | null
  mid_km: number | null
  high_km: number | null
  has_zone_data: boolean
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
  // Run-only mileage broken down by HR zone band. Server adds it
  // unconditionally; older servers may omit, hence optional here.
  intensity_summary?: IntensitySummary
  // Multi-variant additions (Step 4 backend additive fields).
  variants_summary?: VariantsSummary
  abandoned_scheduled_workouts?: AbandonedScheduledWorkout[]
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

export interface HRVSnapshot {
  avg_sleep_hrv: number | null
  hrv_normal_low: number | null
  hrv_normal_high: number | null
  recovery_pct: number | null
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
  baseline_balanced_low: number | null
  baseline_balanced_upper: number | null
  feedback_phrase: string | null
  provider: string | null
}

export interface HrvSummary {
  date: string | null
  last_night_avg: number | null
  weekly_avg: number | null
  status: string | null
  baseline_balanced_low: number | null
  baseline_balanced_upper: number | null
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

export function getPMC(user: string, days = 90) {
  return fetchJSON<{ pmc: PMCRecord[]; summary: PMCSummary }>(`/${user}/pmc?days=${days}`)
}

export interface InBodySegment {
  segment: 'left_arm' | 'right_arm' | 'trunk' | 'left_leg' | 'right_leg'
  lean_mass_kg: number
  fat_mass_kg: number
  lean_pct_of_standard: number | null
  fat_pct_of_standard: number | null
}

export interface InBodyScan {
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
  inbody_score: number | null
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
  segments?: InBodySegment[]
}

export interface InBodyCheckpoint {
  phase: string
  date: string
  weight_kg: number
  body_fat_pct: number
  smm_kg_min: number
}

export interface InBodyDeltas {
  prev_date: string
  weight_kg: number
  body_fat_pct: number
  smm_kg: number
  fat_mass_kg: number
  visceral_fat_level: number
}

export interface InBodySummary {
  latest: InBodyScan | null
  deltas: InBodyDeltas | null
  checkpoints: InBodyCheckpoint[]
}

export function getInbody(user: string, days?: number) {
  const qs = days ? `?days=${days}` : ''
  return fetchJSON<{ scans: InBodyScan[] }>(`/${user}/inbody${qs}`)
}

export function getInbodySummary(user: string) {
  return fetchJSON<InBodySummary>(`/${user}/inbody/summary`)
}

export function getInbodyScan(user: string, scanDate: string) {
  return fetchJSON<InBodyScan>(`/${user}/inbody/${scanDate}`)
}

export function getWeeks(user: string) {
  return fetchJSON<{ weeks: WeekSummary[] }>(`/${user}/weeks`)
}

// ---------------------------------------------------------------------------
// Ability (4-layer custom running score)
// ---------------------------------------------------------------------------

export interface MarathonEstimates {
  training_s: number | null
  race_s: number | null
  best_case_s: number | null
  race_day_boost_pct?: number
  best_case_boost_pct?: number
}

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
  marathon_target_s?: number | null
  marathon_target_label?: string | null
  marathon_estimates: MarathonEstimates
  evidence_activity_ids: string[]
}

export interface AbilityHistoryPoint {
  date: string
  l4_composite: number | null
  l4_marathon_race_s: number | null
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

export function pushPlannedSession(user: string, date: string, sessionIndex: number) {
  return postJSON<PushPlannedSessionResponse>(
    `/${user}/plan/sessions/${date}/${sessionIndex}/push`,
  )
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

export interface ActivityDetailResponse {
  activity: Activity
  laps: Lap[]
  segments: Segment[]
  zones: Zone[]
  timeseries: TimeseriesPoint[]
  linked_scheduled_workout?: LinkedScheduledWorkout | null
}

export function getActivity(user: string, id: string) {
  return fetchJSON<ActivityDetailResponse>(
    `/${user}/activities/${id}`
  )
}

export function getTeamActivity(teamId: string, userId: string, labelId: string) {
  return fetchJSON<ActivityDetailResponse>(
    `/teams/${teamId}/activities/${userId}/${labelId}`
  )
}

export function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null
  // Handle ISO format: 2026-04-04T11:53:48.710000+00:00
  if (dateStr.includes('T')) return new Date(dateStr)
  // Handle YYYYMMDD format
  if (dateStr.length === 8) {
    return new Date(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8))
  }
  // Handle YYYY-MM-DD
  return new Date(dateStr)
}

export function formatDate(dateStr: string): string {
  const d = parseDate(dateStr)
  if (!d || isNaN(d.getTime())) return dateStr
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function formatDateShort(dateStr: string): string {
  const d = parseDate(dateStr)
  if (!d || isNaN(d.getTime())) return dateStr
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

// HH:MM:SS in Shanghai time. The DB stores UTC; running data is interpreted
// against Shanghai local time everywhere else in this app, so pin the TZ
// instead of trusting browser locale.
const TIME_FMT_SHANGHAI = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export function formatTime(dateStr: string): string {
  const d = parseDate(dateStr)
  if (!d || isNaN(d.getTime())) return ''
  return TIME_FMT_SHANGHAI.format(d)
}

export function formatWeekRange(dateFrom: string, dateTo: string): string {
  const df = parseDate(dateFrom)
  const dt = parseDate(dateTo)
  if (!df || !dt) return `${dateFrom} — ${dateTo}`
  return `${df.getMonth() + 1}/${df.getDate()} — ${dt.getMonth() + 1}/${dt.getDate()}`
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

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function weekdayCN(dateStr: string): string {
  const d = parseDate(dateStr)
  if (!d || isNaN(d.getTime())) return ''
  return WEEKDAY_CN[d.getDay()]
}

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
