/**
 * Defensive projection of a raw canonical `WeeklyPlan` (the body of a
 * `WeeklyPlanCreateProposal`) into the UI shapes the create Review renders.
 *
 * The raw plan is untrusted external JSON — every leaf is narrowed before use.
 * We split the canonical plan into three surfaces:
 *   - `days`       — the Mon–Sun training calendar (one row per session)
 *   - `strength`   — the standalone strength section (exercises, sets, target…)
 *   - `nutrition`  — the standalone nutrition section (kcal/macros/water/meals)
 * plus the plan-level `notesMd` (weekly note).
 *
 * The `rawProposal` is never mutated here; callers keep it verbatim for apply.
 */
import type {
  CreatePlanDay,
  CreatePlanMeal,
  CreatePlanNutritionDay,
  CreatePlanStrengthDay,
  CreatePlanStrengthExercise,
} from './types'

/** The three Review surfaces projected from a canonical `WeeklyPlan`. */
export interface WeeklyCreateProjection {
  readonly days: readonly CreatePlanDay[]
  readonly strength: readonly CreatePlanStrengthDay[]
  readonly nutrition: readonly CreatePlanNutritionDay[]
  readonly notesMd: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function sessionKindLabel(value: unknown): string {
  const labels: Readonly<Record<string, string>> = {
    run: '跑步训练',
    strength: '力量训练',
    rest: '休息',
    cross: '交叉训练',
    note: '教练备注',
  }
  const kind = str(value)
  return (kind && labels[kind]) || '训练安排'
}

/** Format a strength target from `target_kind` + `target_value`. */
function formatStrengthTarget(kind: unknown, value: unknown): string | null {
  const n = num(value)
  if (n == null) return null
  const k = str(kind)
  if (k === 'time_s') return `${n} 秒`
  // Default (`reps`) and unknown kinds render as repetitions.
  return `${n} 次`
}

function projectExercise(raw: unknown): CreatePlanStrengthExercise | null {
  const ex = asRecord(raw)
  if (!ex) return null
  const name = str(ex.display_name) ?? str(ex.name) ?? str(ex.canonical_id)
  if (!name) return null
  const sets = num(ex.sets)
  const target = formatStrengthTarget(ex.target_kind, ex.target_value)
  const restN = num(ex.rest_seconds)
  return {
    name,
    sets: sets ?? null,
    target,
    rest: restN != null ? `休息 ${restN} 秒` : null,
    note: str(ex.note) ?? null,
  }
}

function projectStrengthDay(session: Record<string, unknown>): CreatePlanStrengthDay | null {
  const label = str(session.date)
  if (!label) return null
  const spec = asRecord(session.spec)
  const rawExercises = spec && Array.isArray(spec.exercises) ? spec.exercises : []
  const exercises = rawExercises
    .map(projectExercise)
    .filter((e): e is CreatePlanStrengthExercise => e !== null)
  return {
    label,
    title: (spec && str(spec.name)) ?? str(session.summary) ?? null,
    exercises,
    note: (spec && str(spec.note)) ?? str(session.notes_md) ?? null,
  }
}

function projectMeal(raw: unknown): CreatePlanMeal | null {
  const meal = asRecord(raw)
  if (!meal) return null
  const name = str(meal.name)
  if (!name) return null
  return {
    name,
    timeHint: str(meal.time_hint) ?? null,
    kcal: num(meal.kcal),
    carbsG: num(meal.carbs_g),
    proteinG: num(meal.protein_g),
    fatG: num(meal.fat_g),
    itemsMd: str(meal.items_md) ?? null,
  }
}

function projectNutritionDay(raw: unknown): CreatePlanNutritionDay | null {
  const day = asRecord(raw)
  if (!day) return null
  const label = str(day.date)
  if (!label) return null
  const rawMeals = Array.isArray(day.meals) ? day.meals : []
  return {
    label,
    kcalTarget: num(day.kcal_target),
    carbsG: num(day.carbs_g),
    proteinG: num(day.protein_g),
    fatG: num(day.fat_g),
    waterMl: num(day.water_ml),
    meals: rawMeals.map(projectMeal).filter((m): m is CreatePlanMeal => m !== null),
    notesMd: str(day.notes_md) ?? null,
  }
}

/**
 * Project the raw create-proposal body into the three Review surfaces.
 *
 * Accepts either the canonical proposal body (`{ plan: WeeklyPlan, … }`) or a
 * bare `WeeklyPlan` (`{ sessions, nutrition, notes_md }`). Missing or malformed
 * sub-trees degrade to empty arrays rather than throwing — the Review then
 * simply omits the empty section.
 */
export function projectWeeklyCreate(rawProposal: unknown): WeeklyCreateProjection {
  const outer = asRecord(rawProposal)
  const plan = (outer && asRecord(outer.plan)) ?? outer
  if (!plan) {
    return { days: [], strength: [], nutrition: [], notesMd: null }
  }

  const sessions = Array.isArray(plan.sessions) ? plan.sessions : []
  const days: CreatePlanDay[] = []
  const strength: CreatePlanStrengthDay[] = []

  for (const raw of sessions) {
    const session = asRecord(raw)
    if (!session) continue
    const label = str(session.date)
    if (!label) continue

    // Every session — strength included — stays on the Mon–Sun calendar, so a
    // day with multiple sessions shows them all. Strength additionally gets a
    // detailed row in the standalone strength section below.
    const detail = str(session.summary) ?? str(session.notes_md) ?? sessionKindLabel(session.kind)
    days.push({ label, detail })

    if (str(session.kind) === 'strength') {
      const day = projectStrengthDay(session)
      if (day) strength.push(day)
    }
  }

  const rawNutrition = Array.isArray(plan.nutrition) ? plan.nutrition : []
  const nutrition = rawNutrition
    .map(projectNutritionDay)
    .filter((d): d is CreatePlanNutritionDay => d !== null)

  return {
    days,
    strength,
    nutrition,
    notesMd: str(plan.notes_md) ?? null,
  }
}
