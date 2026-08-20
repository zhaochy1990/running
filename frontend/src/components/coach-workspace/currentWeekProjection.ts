/**
 * Project the already-loaded current-week plan (typed `PlanDay[]` from
 * `getPlanDays`) into the same three Review surfaces `CreateReview` renders.
 *
 * This lets the adjust *intake* state show the full current plan with the exact
 * component the generated proposal is reviewed with — so "current" and
 * "proposed" read identically instead of the current plan being a bare one-liner.
 *
 * Unlike `weeklyCreateProjection` (which defensively narrows untrusted proposal
 * JSON), this projection consumes the API's already-typed shapes, so no leaf
 * narrowing is needed.
 */
import type { PlanDay } from '../../api'
import type { Meal, PlannedNutrition, PlannedSession, StrengthExerciseSpec } from '../../types/plan'
import type {
  CreatePlanDay,
  CreatePlanMeal,
  CreatePlanNutritionDay,
  CreatePlanStrengthDay,
  CreatePlanStrengthExercise,
} from './types'
import type { WeeklyCreateProjection } from './weeklyCreateProjection'

const KIND_LABEL: Readonly<Record<PlannedSession['kind'], string>> = {
  run: '跑步训练',
  strength: '力量训练',
  rest: '休息',
  cross: '交叉训练',
  note: '教练备注',
}

/** One calendar row's detail: summary → note → the kind's generic label. */
function sessionDetail(session: PlannedSession): string {
  return session.summary || session.notes_md || KIND_LABEL[session.kind] || '训练安排'
}

/** Format a strength target from `target_kind` + `target_value` (reps or time). */
function formatStrengthTarget(exercise: StrengthExerciseSpec): string | null {
  if (!Number.isFinite(exercise.target_value)) return null
  if (exercise.target_kind === 'time_s') return `${exercise.target_value} 秒`
  return `${exercise.target_value} 次`
}

function projectExercise(exercise: StrengthExerciseSpec): CreatePlanStrengthExercise {
  const rest =
    Number.isFinite(exercise.rest_seconds) && exercise.rest_seconds > 0
      ? `休息 ${exercise.rest_seconds} 秒`
      : null
  return {
    name: exercise.display_name || exercise.canonical_id,
    sets: Number.isFinite(exercise.sets) ? exercise.sets : null,
    target: formatStrengthTarget(exercise),
    rest,
    note: exercise.note ?? null,
  }
}

function projectMeal(meal: Meal): CreatePlanMeal {
  return {
    name: meal.name,
    timeHint: meal.time_hint,
    kcal: meal.kcal,
    carbsG: meal.carbs_g,
    proteinG: meal.protein_g,
    fatG: meal.fat_g,
    itemsMd: meal.items_md,
  }
}

function projectNutrition(nutrition: PlannedNutrition): CreatePlanNutritionDay {
  return {
    label: nutrition.date,
    kcalTarget: nutrition.kcal_target,
    carbsG: nutrition.carbs_g,
    proteinG: nutrition.protein_g,
    fatG: nutrition.fat_g,
    waterMl: nutrition.water_ml,
    meals: nutrition.meals.map(projectMeal),
    notesMd: nutrition.notes_md,
  }
}

/**
 * Project the current week's `PlanDay[]` into the training calendar, standalone
 * strength section, and nutrition section. Every day emits a calendar row — a
 * day with no sessions renders as an explicit rest row — so the whole Mon–Sun
 * week is visible. `notesMd` is not carried by `getPlanDays`, so it is null.
 */
export function projectCurrentWeekPlan(days: readonly PlanDay[]): WeeklyCreateProjection {
  const calendar: CreatePlanDay[] = []
  const strength: CreatePlanStrengthDay[] = []
  const nutrition: CreatePlanNutritionDay[] = []

  for (const day of days) {
    if (day.sessions.length === 0) {
      calendar.push({ label: day.date, detail: '休息 · 无训练安排' })
    } else {
      for (const session of day.sessions) {
        calendar.push({ label: session.date || day.date, detail: sessionDetail(session) })
        if (session.kind === 'strength' && session.spec?.schema === 'strength-workout/v1') {
          strength.push({
            label: session.date || day.date,
            title: session.spec.name || session.summary || null,
            exercises: session.spec.exercises.map(projectExercise),
            note: session.spec.note ?? session.notes_md ?? null,
          })
        }
      }
    }
    if (day.nutrition) nutrition.push(projectNutrition(day.nutrition))
  }

  return { days: calendar, strength, nutrition, notesMd: null }
}
