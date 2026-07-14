import type { Activity, ActivityMonthlySummary } from '../api'
import { isRunActivity, isStrengthActivity } from '../lib/activityKinds'
import { shanghaiDate } from '../lib/shanghai'

export { isRunActivity, isStrengthActivity } from '../lib/activityKinds'

export const ACTIVITY_PAGE_SIZE = 25
export const ACTIVITY_PAGE_SIZE_OPTIONS = [25, 50, 75, 100] as const

export type ActivitySportFilter = 'all' | 'run' | 'strength'

export interface ActivityFilters {
  sport: ActivitySportFilter
  minDistanceKm: number
}

export interface ActivitySummary {
  totalRunKm: number
  runDurationS: number
  avgPaceSecPerKm: number | null
  avgRunHr: number | null
  strengthCount: number
  strengthDurationS: number
}

export interface ActivityMonthGroup {
  key: string
  label: string
  activities: Activity[]
  summary?: ActivityMonthlySummary
}

export type PageItem = number | 'ellipsis-left' | 'ellipsis-right'

export function activityIconLabel(activity: Activity): '跑' | '力' | '动' {
  if (isRunActivity(activity)) return '跑'
  if (isStrengthActivity(activity)) return '力'
  return '动'
}

export function filterActivities(activities: Activity[], filters: ActivityFilters): Activity[] {
  return activities.filter(activity => {
    if (filters.sport === 'run' && !isRunActivity(activity)) return false
    if (filters.sport === 'strength' && !isStrengthActivity(activity)) return false
    if (filters.minDistanceKm > 0 && (activity.distance_km ?? 0) < filters.minDistanceKm) return false
    return true
  })
}

export function summarizeActivities(activities: Activity[]): ActivitySummary {
  let totalRunKm = 0
  let runDurationS = 0
  let strengthCount = 0
  let strengthDurationS = 0
  let hrDurationS = 0
  let weightedHr = 0

  for (const activity of activities) {
    if (isRunActivity(activity)) {
      totalRunKm += activity.distance_km ?? 0
      runDurationS += activity.duration_s ?? 0
      if (activity.avg_hr != null && activity.duration_s > 0) {
        weightedHr += activity.avg_hr * activity.duration_s
        hrDurationS += activity.duration_s
      }
    }

    if (isStrengthActivity(activity)) {
      strengthCount += 1
      strengthDurationS += activity.duration_s ?? 0
    }
  }

  return {
    totalRunKm: Math.round(totalRunKm * 10) / 10,
    runDurationS,
    avgPaceSecPerKm: totalRunKm > 0 ? Math.round(runDurationS / totalRunKm) : null,
    avgRunHr: hrDurationS > 0 ? Math.round(weightedHr / hrDurationS) : null,
    strengthCount,
    strengthDurationS,
  }
}

export function groupActivitiesByMonth(
  activities: Activity[],
  summaries: Record<string, ActivityMonthlySummary> = {},
): ActivityMonthGroup[] {
  const groups: ActivityMonthGroup[] = []
  const groupByKey = new Map<string, ActivityMonthGroup>()

  for (const activity of activities) {
    const monthKey = shanghaiDate(activity.date).slice(0, 7) || 'unknown'
    let group = groupByKey.get(monthKey)
    if (!group) {
      group = {
        key: monthKey,
        label: formatMonthLabel(monthKey),
        activities: [],
        summary: summaries[monthKey],
      }
      groupByKey.set(monthKey, group)
      groups.push(group)
    }
    group.activities.push(activity)
  }

  return groups
}

export function paginateActivities(
  activities: Activity[],
  requestedPage: number,
): { page: number; totalPages: number; start: number; items: Activity[] } {
  const totalPages = Math.max(1, Math.ceil(activities.length / ACTIVITY_PAGE_SIZE))
  const page = Math.min(Math.max(1, requestedPage), totalPages)
  const start = (page - 1) * ACTIVITY_PAGE_SIZE
  return {
    page,
    totalPages,
    start,
    items: activities.slice(start, start + ACTIVITY_PAGE_SIZE),
  }
}

export function visiblePageItems(currentPage: number, totalPages: number): PageItem[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1)

  const current = Math.min(Math.max(1, currentPage), totalPages)
  if (current <= 4) return [1, 2, 3, 4, 5, 'ellipsis-right', totalPages]
  if (current >= totalPages - 3) {
    return [
      1,
      'ellipsis-left',
      totalPages - 4,
      totalPages - 3,
      totalPages - 2,
      totalPages - 1,
      totalPages,
    ]
  }

  return [1, 'ellipsis-left', current - 1, current, current + 1, 'ellipsis-right', totalPages]
}

export function monthRangeFromShanghaiToday(today: string): { label: string; dateFrom: string; dateTo: string } {
  const [yearText, monthText] = today.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const mm = String(month).padStart(2, '0')

  return {
    label: `${year} 年 ${month} 月`,
    dateFrom: `${year}-${mm}-01`,
    dateTo: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
  }
}

export function formatHoursMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours <= 0) return `${restMinutes} 分`
  if (restMinutes === 0) return `${hours} 小时`
  return `${hours} 小时 ${restMinutes} 分`
}

export function formatPaceSeconds(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '--'
  const rounded = Math.round(seconds)
  const minutes = Math.floor(rounded / 60)
  const restSeconds = rounded % 60
  return `${minutes}'${String(restSeconds).padStart(2, '0')}"`
}

function formatMonthLabel(key: string): string {
  const [year, month] = key.split('-')
  if (!year || !month) return '未知月份'
  return `${year} 年 ${Number(month)} 月`
}
