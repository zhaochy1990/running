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
//
// HR_HIGH_MIN=160 covers tempo/threshold sessions whose target HR sits in
// the 160-170 band (Z4 for this user). PACE_HIGH_MAX=250 (4:10/km) so
// 节奏跑 at 4:05-4:10/km counts as high — the previous 4:00/km cutoff
// missed real tempo work.
const HR_LOW_MAX = 155 // avg hr below this → Z1-Z2
const HR_HIGH_MIN = 160 // avg hr at/above this → Z4-Z5
const PACE_LOW_MIN = 270 // avg pace slower than 4:30/km → low
const PACE_HIGH_MAX = 250 // avg pace faster than 4:10/km → high

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

/** Distance contributed by a single work step, or null if the step isn't
 * `step_kind=work` or its distance can't be determined. Time-based work
 * steps with a pace target are estimated via `time_s / pace_s_km`. */
function workStepDistanceKm(step: WorkoutStep): number | null {
  if (step.step_kind !== 'work') return null
  const dur = step.duration
  if (dur.kind === 'distance_m' && dur.value != null) {
    return dur.value / 1000
  }
  if (dur.kind === 'time_s' && dur.value != null) {
    const t = step.target
    if (t.kind === 'pace_s_km' && t.low != null && t.high != null) {
      const paceAvg = (t.low + t.high) / 2
      if (paceAvg > 0) return dur.value / paceAvg
    }
  }
  return null
}

/** Compute a session's km-by-tier breakdown.
 *
 * Strategy: only `step_kind=work` steps that classify as mid/high are
 * counted as "quality work". Everything else — warmup, cooldown, recovery,
 * and easy work — collapses into the low bucket via `low = sessionTotalKm
 * − quality`. This lets a 4×3K interval session (14.5 km total) report
 * exactly 12 km high and 2.5 km low, regardless of how the spec encodes
 * the warmup/recovery/cooldown (distance-based, time-based, or open).
 */
function breakdownFromSpec(
  spec: NormalizedRunWorkout,
  sessionTotalKm: number,
): SessionBreakdown {
  let high = 0
  let mid = 0
  for (const block of spec.blocks) {
    const repeat = Math.max(1, block.repeat || 1)
    for (let r = 0; r < repeat; r++) {
      for (const step of block.steps) {
        const km = workStepDistanceKm(step)
        if (km == null || km <= 0) continue
        const tier = classifyStep(step)
        if (tier === 'high') high += km
        else if (tier === 'mid') mid += km
        // Low-classified work merges into the easy remainder below.
      }
    }
  }

  const quality = high + mid
  if (quality >= sessionTotalKm) {
    // Spec-derived quality exceeds the session total (e.g., conservative
    // total_distance_m or work step over-estimate). Cap by scaling the
    // quality buckets down so they fit; low becomes 0.
    const scale = quality > 0 ? sessionTotalKm / quality : 0
    return {
      low_km: 0,
      mid_km: mid * scale,
      high_km: high * scale,
    }
  }

  return {
    low_km: sessionTotalKm - quality,
    mid_km: mid,
    high_km: high,
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
    if (spec) {
      const sb = breakdownFromSpec(spec, km)
      low += sb.low_km
      mid += sb.mid_km
      high += sb.high_km
      continue
    }

    // No spec — classify whole session by text.
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
