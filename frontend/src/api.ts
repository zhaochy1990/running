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

export function getUsers() {
  return fetchJSON<{ users: string[] }>('/users')
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
  return fetchJSON<{ health: HealthRecord[]; hrv: HRVSnapshot }>(`/${user}/health?days=${days}`)
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

export function getWeek(user: string, folder: string) {
  return fetchJSON<WeekDetail>(`/${user}/weeks/${folder}`)
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
