// Compute planned-mileage intensity breakdown for a week's PlannedSession[].
//
// Bands: low = Z1+Z2, mid = Z3, high = Z4+Z5. Each run session contributes
// its planned distance distributed across bands using step-level
// classification when a structured spec is available, falling back to
// session-level RPE/keyword classification otherwise.
//
// HR/pace thresholds are calibrated for sub-3:00 marathoners (the typical
// app user). They're intentionally absolute (not user-zone-aware) — making
// them user-aware would require wiring HR zones through to the calendar
// payload, which we can do later if the headline numbers feel off.

import type {
  NormalizedRunWorkout,
  PlannedSession,
  WorkoutStep,
} from '../types/plan'

export type IntensityTier = 'low' | 'mid' | 'high'

export interface PlanIntensity {
  total_km: number
  low_km: number
  mid_km: number
  high_km: number
}

// Tunables (sub-3:00 marathoner defaults).
const HR_LOW_MAX = 155 // avg hr below this → Z1-Z2
const HR_HIGH_MIN = 168 // avg hr at/above this → Z4-Z5
const PACE_LOW_MIN = 270 // avg pace slower than 4:30/km → low
const PACE_HIGH_MAX = 240 // avg pace faster than 4:00/km → high

const HIGH_KEYWORDS = [
  '间歇',
  'interval',
  '冲刺',
  'sprint',
  '阈',
  'threshold',
  'vo2',
  '高强度',
  '5km配速',
  '10km配速',
]
const LOW_KEYWORDS = [
  '恢复',
  'recovery',
  '轻松',
  'easy',
  '长距离',
  'long run',
  'base',
  '有氧',
  'aerobic',
  '慢跑',
]

export function classifyStep(step: WorkoutStep): IntensityTier {
  if (
    step.step_kind === 'warmup' ||
    step.step_kind === 'cooldown' ||
    step.step_kind === 'recovery'
  ) {
    return 'low'
  }
  if (step.step_kind === 'rest') return 'mid' // skipped at the caller
  // step_kind === 'work': derive from target.
  const t = step.target
  if (t.kind === 'hr_bpm' && t.low != null && t.high != null) {
    const avg = (t.low + t.high) / 2
    if (avg < HR_LOW_MAX) return 'low'
    if (avg >= HR_HIGH_MIN) return 'high'
    return 'mid'
  }
  if (t.kind === 'pace_s_km' && t.low != null && t.high != null) {
    const avg = (t.low + t.high) / 2
    if (avg > PACE_LOW_MIN) return 'low'
    if (avg <= PACE_HIGH_MAX) return 'high'
    return 'mid'
  }
  return 'mid'
}

export function classifySessionByText(s: PlannedSession): IntensityTier {
  const text = `${s.summary} ${s.notes_md ?? ''}`
  const rpe = /RPE\s*(\d+(?:\.\d+)?)/i.exec(text)
  if (rpe) {
    const n = parseFloat(rpe[1])
    if (n <= 4) return 'low'
    if (n >= 6) return 'high'
    return 'mid'
  }
  const lower = text.toLowerCase()
  if (HIGH_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) return 'high'
  if (LOW_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) return 'low'
  return 'mid'
}

interface SessionBreakdown {
  low_km: number
  mid_km: number
  high_km: number
}

function breakdownFromSpec(
  spec: NormalizedRunWorkout,
  sessionTotalKm: number,
): SessionBreakdown | null {
  let low = 0
  let mid = 0
  let high = 0
  let known = 0

  for (const block of spec.blocks) {
    const repeat = Math.max(1, block.repeat || 1)
    for (let r = 0; r < repeat; r++) {
      for (const step of block.steps) {
        if (step.step_kind === 'rest') continue
        const dur = step.duration
        if (dur.kind !== 'distance_m' || dur.value == null) continue
        const km = dur.value / 1000
        known += km
        const tier = classifyStep(step)
        if (tier === 'low') low += km
        else if (tier === 'high') high += km
        else mid += km
      }
    }
  }

  if (known <= 0) return null

  // Reconcile to session total — the spec's distance steps may not perfectly
  // sum to total_distance_m (open steps, time-based steps, etc.). Use
  // proportional scaling so the buckets sum to sessionTotalKm.
  const scale = sessionTotalKm / known
  return {
    low_km: low * scale,
    mid_km: mid * scale,
    high_km: high * scale,
  }
}

export function computeWeekPlanIntensity(
  sessions: PlannedSession[],
): PlanIntensity {
  let total = 0
  let low = 0
  let mid = 0
  let high = 0

  for (const s of sessions) {
    if (s.kind !== 'run') continue
    const distM = s.total_distance_m ?? 0
    if (distM <= 0) continue
    const km = distM / 1000
    total += km

    const spec =
      s.spec && s.spec.schema === 'run-workout/v1'
        ? (s.spec as NormalizedRunWorkout)
        : null
    const stepBreakdown = spec ? breakdownFromSpec(spec, km) : null
    if (stepBreakdown) {
      low += stepBreakdown.low_km
      mid += stepBreakdown.mid_km
      high += stepBreakdown.high_km
      continue
    }

    // Fallback: classify whole session by text.
    const tier = classifySessionByText(s)
    if (tier === 'low') low += km
    else if (tier === 'high') high += km
    else mid += km
  }

  // Round to 1 decimal — display precision; keeps sums consistent enough.
  return {
    total_km: Math.round(total * 10) / 10,
    low_km: Math.round(low * 10) / 10,
    mid_km: Math.round(mid * 10) / 10,
    high_km: Math.round(high * 10) / 10,
  }
}
