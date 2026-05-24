/**
 * Roll daily STRIDE training_dose into a fixed 8-bucket weekly series for
 * the 8-week load trend chart on the training-status page.
 *
 * Why this lives here: `daily_training_load` already stores per-day totals
 * (sum of activity-level dose, EWMA acute/chronic, etc.) in Shanghai-local
 * `YYYY-MM-DD`, so weekly rollup is a pure client aggregation — no new
 * schema, no backfill. See `docs/working-model.md` for the wider rationale.
 */

import { shanghaiToday, shanghaiWeekStart } from './shanghai'

/** Minimal record shape — anything with a date string and an optional dose
 *  numeric works (currently `StrideTrainingLoadRecord` from the API). */
export interface DailyDoseRow {
  date: string
  training_dose: number | null
}

export interface WeeklyDoseBucket {
  /** Monday of the bucket, Shanghai-local `YYYY-MM-DD`. */
  weekStart: string
  /** Short label for chart X-axis, `M/D` of the Monday. */
  weekLabel: string
  /** Sum of `training_dose` across all days falling in this Shanghai week. */
  totalDose: number
  /** Days within the week that had a non-zero training_dose recorded. */
  activeDays: number
}

const WEEKS = 8

/**
 * Build the 8-week trailing window ending in the Shanghai week of `today`.
 *
 * The output is always exactly 8 buckets, oldest first, with zero totals for
 * weeks lacking data — so the rendered line stays continuous and the chart
 * domain is stable even when the user has no recent activities.
 *
 * Records outside the window (older than 8 weeks, or after the current
 * Shanghai week) are silently dropped.
 */
export function aggregateWeeklyDose(
  records: readonly DailyDoseRow[],
  today: string = shanghaiToday(),
): WeeklyDoseBucket[] {
  const currentWeekStart = shanghaiWeekStart(today)
  if (!currentWeekStart) return []

  const [y, m, d] = currentWeekStart.split('-').map(Number)
  const anchor = new Date(Date.UTC(y, m - 1, d))

  const buckets = new Map<string, WeeklyDoseBucket>()
  const orderedStarts: string[] = []
  for (let i = WEEKS - 1; i >= 0; i--) {
    const t = new Date(anchor)
    t.setUTCDate(anchor.getUTCDate() - i * 7)
    const yy = t.getUTCFullYear()
    const mm = String(t.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(t.getUTCDate()).padStart(2, '0')
    const key = `${yy}-${mm}-${dd}`
    orderedStarts.push(key)
    buckets.set(key, {
      weekStart: key,
      weekLabel: `${t.getUTCMonth() + 1}/${t.getUTCDate()}`,
      totalDose: 0,
      activeDays: 0,
    })
  }

  for (const r of records) {
    if (r.training_dose == null) continue
    const weekStart = shanghaiWeekStart(r.date)
    const bucket = buckets.get(weekStart)
    if (!bucket) continue
    bucket.totalDose += r.training_dose
    if (r.training_dose > 0) bucket.activeDays += 1
  }

  return orderedStarts.map((k) => buckets.get(k)!)
}
