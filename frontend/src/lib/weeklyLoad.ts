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
  coverage_status?: string
}

export interface WeeklyDoseBucket {
  /** Monday of the bucket, Shanghai-local `YYYY-MM-DD`. */
  weekStart: string
  /** Short label for chart X-axis, `M/D` of the Monday. */
  weekLabel: string
  /** Sum of known daily dose, or null when the week contains a coverage gap. */
  totalDose: number | null
  /** Days within the week that had a non-zero training_dose recorded. */
  activeDays: number
}

const WEEKS = 8

/**
 * Build the 8-week trailing window ending in the Shanghai week of `today`.
 *
 * The output is always exactly 8 buckets, oldest first. Weeks lacking observed
 * coverage, or containing an explicit `unknown` placeholder, expose a null
 * total so charts render a gap instead of inventing a zero-load rest week.
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
  const unknownWeeks = new Set<string>()
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
      totalDose: null,
      activeDays: 0,
    })
  }

  for (const r of records) {
    const weekStart = shanghaiWeekStart(r.date)
    const bucket = buckets.get(weekStart)
    if (!bucket) continue
    if (r.coverage_status === 'unknown') {
      unknownWeeks.add(weekStart)
      continue
    }
    if (r.training_dose == null) continue
    bucket.totalDose = (bucket.totalDose ?? 0) + r.training_dose
    if (r.training_dose > 0) bucket.activeDays += 1
  }

  return orderedStarts.map((k) => {
    const bucket = buckets.get(k)!
    return unknownWeeks.has(k) ? { ...bucket, totalDose: null } : bucket
  })
}
