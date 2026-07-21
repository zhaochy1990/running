import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { shanghaiWeekday } from '../../lib/shanghai'
import type {
  CreatePlanDay,
  CreatePlanNutritionDay,
  CreatePlanStrengthDay,
} from './types'

interface CreateReviewProps {
  readonly days: readonly CreatePlanDay[]
  readonly strength?: readonly CreatePlanStrengthDay[]
  readonly nutrition?: readonly CreatePlanNutritionDay[]
  /** Plan-level weekly note (safe Markdown; raw HTML is never enabled). */
  readonly notesMd?: string | null
}

/** Matches a leading ISO date (`YYYY-MM-DD`) in a day label. */
const ISO_DATE = /^(\d{4}-\d{2}-\d{2})/
/** Any Chinese weekday token already present in the label. */
const HAS_WEEKDAY = /周[一二三四五六日]/

/**
 * Build the card title: for an ISO-dated label, append the Shanghai weekday
 * with a middle-dot separator (`2026-07-20 · 周一`). Labels that already carry
 * a weekday, or that are not ISO dates, are returned unchanged so we never
 * duplicate the weekday.
 */
function titleFor(label: string): string {
  const match = ISO_DATE.exec(label)
  if (!match || HAS_WEEKDAY.test(label)) return label
  const weekday = shanghaiWeekday(match[1])
  return weekday ? `${label} · ${weekday}` : label
}

/** Render the Mon–Sun training calendar (one card per session, all kinds). */
function TrainingCalendar({ days }: { readonly days: readonly CreatePlanDay[] }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
        本周训练日历
      </h3>
      <ul className="space-y-3">
        {days.map((day, i) => (
          <li
            key={`${day.label}-${i}`}
            className="rounded-lg border border-border-subtle bg-bg-primary p-3"
          >
            <div className="mb-1 text-sm font-medium text-text-primary">{titleFor(day.label)}</div>
            <div className="text-sm text-text-muted">{day.detail}</div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Render the standalone strength section (exercises, sets, target, rest, note). */
function StrengthSection({ strength }: { readonly strength: readonly CreatePlanStrengthDay[] }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
        力量训练
      </h3>
      <ul className="space-y-3">
        {strength.map((day, i) => (
          <li
            key={`${day.label}-${i}`}
            className="rounded-lg border border-border-subtle bg-bg-primary p-3"
          >
            <div className="mb-2 text-sm font-medium text-text-primary">
              {titleFor(day.label)}
              {day.title ? ` · ${day.title}` : ''}
            </div>
            {day.exercises.length > 0 ? (
              <ul className="space-y-1.5">
                {day.exercises.map((ex, j) => (
                  <li key={`${ex.name}-${j}`} className="text-sm text-text-muted">
                    <span className="text-text-primary">{ex.name}</span>
                    {ex.sets != null && <span> · {ex.sets} 组</span>}
                    {ex.target && <span> × {ex.target}</span>}
                    {ex.rest && <span> · {ex.rest}</span>}
                    {ex.note && <span className="text-text-muted"> — {ex.note}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-sm text-text-muted">未安排具体动作</div>
            )}
            {day.note && <div className="mt-2 text-sm text-text-muted">{day.note}</div>}
          </li>
        ))}
      </ul>
    </section>
  )
}

function formatMacro(label: string, value: number | null | undefined, unit: string): string | null {
  if (value == null) return null
  return `${label} ${value}${unit}`
}

/** Render the standalone nutrition section (kcal/macros/water/meals/notes). */
function NutritionSection({
  nutrition,
}: {
  readonly nutrition: readonly CreatePlanNutritionDay[]
}) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
        营养安排
      </h3>
      <ul className="space-y-3">
        {nutrition.map((day, i) => {
          const macros = [
            formatMacro('热量', day.kcalTarget, ' kcal'),
            formatMacro('碳水', day.carbsG, ' g'),
            formatMacro('蛋白', day.proteinG, ' g'),
            formatMacro('脂肪', day.fatG, ' g'),
            formatMacro('饮水', day.waterMl, ' ml'),
          ].filter((x): x is string => x !== null)
          return (
            <li
              key={`${day.label}-${i}`}
              className="rounded-lg border border-border-subtle bg-bg-primary p-3"
            >
              <div className="mb-1 text-sm font-medium text-text-primary">{titleFor(day.label)}</div>
              {macros.length > 0 && (
                <div className="text-sm text-text-muted">{macros.join(' · ')}</div>
              )}
              {day.meals.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {day.meals.map((meal, j) => {
                    const mealMacros = [
                      meal.kcal != null ? `${meal.kcal} kcal` : null,
                      meal.carbsG != null ? `碳水 ${meal.carbsG} g` : null,
                      meal.proteinG != null ? `蛋白 ${meal.proteinG} g` : null,
                      meal.fatG != null ? `脂肪 ${meal.fatG} g` : null,
                    ].filter((x): x is string => x !== null)
                    return (
                      <li key={`${meal.name}-${j}`} className="text-sm text-text-muted">
                        <span className="text-text-primary">{meal.name}</span>
                        {meal.timeHint && <span> · {meal.timeHint}</span>}
                        {mealMacros.length > 0 && <span> · {mealMacros.join(' · ')}</span>}
                        {meal.itemsMd && <span> — {meal.itemsMd}</span>}
                      </li>
                    )
                  })}
                </ul>
              )}
              {day.notesMd && <div className="mt-2 text-sm text-text-muted">{day.notesMd}</div>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * Full creation Review for a brand-new week (WeeklyCreateProposal). Renders
 * three standalone surfaces projected from the canonical WeeklyPlan: the
 * Mon–Sun training calendar, the strength section, and the nutrition section,
 * plus the plan-level weekly note. Empty sections are omitted.
 *
 * The weekly note uses react-markdown + remark-gfm and never enables rehypeRaw,
 * so raw HTML is treated as plain text.
 */
export function CreateReview({
  days,
  strength = [],
  nutrition = [],
  notesMd,
}: CreateReviewProps) {
  return (
    <div className="space-y-5">
      {notesMd && (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
            本周说明
          </h3>
          <div className="prose prose-sm max-w-none text-sm text-text-muted">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{notesMd}</ReactMarkdown>
          </div>
        </section>
      )}
      {days.length > 0 && <TrainingCalendar days={days} />}
      {strength.length > 0 && <StrengthSection strength={strength} />}
      {nutrition.length > 0 && <NutritionSection nutrition={nutrition} />}
    </div>
  )
}
