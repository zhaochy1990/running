import type { Activity, PlanDay } from '../api'
import { isRunActivity, isStrengthActivity } from './activityKinds'
import { isPushable, type PlannedNutrition, type PlannedSession } from '../types/plan'

export interface WeeklyPlanStats {
  readonly sessions: PlannedSession[]
  readonly nutrition: PlannedNutrition[]
  readonly plannedRunKm: number
  readonly runCount: number
  readonly strengthCount: number
  readonly nutritionDays: number
}

export function weeklyPlanStats(days: readonly PlanDay[]): WeeklyPlanStats {
  const sessions = days.flatMap((day) => day.sessions)
  const nutrition = days.flatMap((day) => day.nutrition ? [day.nutrition] : [])
  return {
    sessions,
    nutrition,
    plannedRunKm: sessions
      .filter((session) => session.kind === 'run')
      .reduce((total, session) => total + (session.total_distance_m ?? 0) / 1000, 0),
    runCount: sessions.filter((session) => session.kind === 'run').length,
    strengthCount: sessions.filter((session) => session.kind === 'strength').length,
    nutritionDays: nutrition.length,
  }
}

export function actualRunDistanceKm(activities: readonly Activity[]): number {
  return activities
    .filter(isRunActivity)
    .reduce((total, activity) => total + (activity.distance_km ?? 0), 0)
}

export interface ActualStrengthStats {
  readonly count: number
  readonly durationS: number
}

export function actualStrengthStats(activities: readonly Activity[]): ActualStrengthStats {
  return activities.reduce<ActualStrengthStats>((stats, activity) => {
    if (!isStrengthActivity(activity)) return stats
    return {
      count: stats.count + 1,
      durationS: stats.durationS + (activity.duration_s ?? 0),
    }
  }, { count: 0, durationS: 0 })
}

export function formatDurationClock(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const remainingSeconds = safeSeconds % 60
  return [hours, minutes, remainingSeconds].map(value => String(value).padStart(2, '0')).join(':')
}

export function pushableSessionsFor(
  sessions: readonly PlannedSession[],
  canPushRun: boolean,
  canPushStrength: boolean,
): PlannedSession[] {
  return sessions.filter((session) => {
    if (!isPushable(session)) return false
    if (session.kind === 'run' && !canPushRun) return false
    if (session.kind === 'strength' && !canPushStrength) return false
    if (session.scheduled_workout_id != null) return false
    return true
  })
}

export function formatSessionLoad(session: PlannedSession): string {
  if (session.total_distance_m != null) return `${(session.total_distance_m / 1000).toFixed(1)} km`
  if (session.total_duration_s != null) return `${Math.round(session.total_duration_s / 60)} min`
  return '—'
}

export function sessionTarget(session: PlannedSession): string | null {
  if (!session.spec || session.spec.schema !== 'run-workout/v1') return null
  for (const block of session.spec.blocks) {
    for (const step of block.steps) {
      if (step.step_kind !== 'work') continue
      if (step.target.kind === 'pace_s_km' && step.target.low != null && step.target.high != null) {
        return `${formatPace(step.target.high)}–${formatPace(step.target.low)}`
      }
      if (step.target.kind === 'hr_bpm' && step.target.low != null && step.target.high != null) {
        return `${Math.round(step.target.low)}–${Math.round(step.target.high)} bpm`
      }
      if (step.hr_cap_bpm != null) return `HR ≤${Math.round(step.hr_cap_bpm)}`
    }
  }
  return null
}

function formatPace(seconds: number): string {
  const rounded = Math.round(seconds)
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}/km`
}
