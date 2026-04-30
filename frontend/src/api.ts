import { refreshAccessToken } from './store/authStore'

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
}

export function triggerSync(user: string) {
  return fetch(`${BASE}/${user}/sync`, { method: 'POST', headers: authHeaders() }).then(r => r.json()) as Promise<{ success: boolean; output?: string; error?: string }>
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

export function getActivity(user: string, id: string) {
  return fetchJSON<{ activity: Activity; laps: Lap[]; segments: Segment[]; zones: Zone[]; timeseries: TimeseriesPoint[] }>(
    `/${user}/activities/${id}`
  )
}

export function getTeamActivity(teamId: string, userId: string, labelId: string) {
  return fetchJSON<{ activity: Activity; laps: Lap[]; segments: Segment[]; zones: Zone[]; timeseries: TimeseriesPoint[] }>(
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
