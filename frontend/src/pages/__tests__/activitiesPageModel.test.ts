import { describe, expect, it } from 'vitest'

import type { Activity } from '../../api'
import {
  filterActivities,
  formatHoursMinutes,
  formatPaceSeconds,
  groupActivitiesByMonth,
  monthRangeFromShanghaiToday,
  paginateActivities,
  summarizeActivities,
} from '../activitiesPageModel'

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    label_id: overrides.label_id ?? 'activity-1',
    name: overrides.name ?? 'Activity',
    sport_type: overrides.sport_type ?? 100,
    sport_name: overrides.sport_name ?? 'Run',
    date: overrides.date ?? '2026-05-08T06:00:00+08:00',
    distance_m: overrides.distance_m ?? 10000,
    distance_km: overrides.distance_km ?? 10,
    duration_s: overrides.duration_s ?? 3000,
    duration_fmt: overrides.duration_fmt ?? '00:50:00',
    avg_pace_s_km: overrides.avg_pace_s_km ?? 300,
    pace_fmt: overrides.pace_fmt ?? '5:00/km',
    avg_hr: overrides.avg_hr ?? 145,
    max_hr: overrides.max_hr ?? 170,
    avg_cadence: overrides.avg_cadence ?? 180,
    calories_kcal: overrides.calories_kcal ?? 500,
    training_load: overrides.training_load ?? 120,
    vo2max: overrides.vo2max ?? null,
    train_type: overrides.train_type ?? null,
    ascent_m: overrides.ascent_m ?? null,
    aerobic_effect: overrides.aerobic_effect ?? null,
    anaerobic_effect: overrides.anaerobic_effect ?? null,
    temperature: overrides.temperature ?? null,
    humidity: overrides.humidity ?? null,
    feels_like: overrides.feels_like ?? null,
    wind_speed: overrides.wind_speed ?? null,
    feel_type: overrides.feel_type ?? null,
    sport_note: overrides.sport_note ?? null,
    pauses: overrides.pauses ?? [],
    route_thumb: overrides.route_thumb ?? null,
  }
}

describe('activitiesPageModel', () => {
  it('filters by frontend sport category and minimum distance', () => {
    const run10 = makeActivity({ label_id: 'run10', distance_km: 10, distance_m: 10000 })
    const run5 = makeActivity({ label_id: 'run5', distance_km: 5, distance_m: 5000 })
    const strength = makeActivity({
      label_id: 'strength',
      sport_type: 402,
      sport_name: 'Strength Training',
      distance_km: 0,
      distance_m: 0,
    })

    expect(filterActivities([run10, run5, strength], { sport: 'run', minDistanceKm: 10 })).toEqual([run10])
    expect(filterActivities([run10, run5, strength], { sport: 'strength', minDistanceKm: 0 })).toEqual([strength])
  })

  it('groups activities by Shanghai month while preserving input order', () => {
    const may = makeActivity({ label_id: 'may', date: '2026-05-08T06:00:00+08:00' })
    const april = makeActivity({ label_id: 'april', date: '2026-04-30T20:00:00+08:00' })

    expect(groupActivitiesByMonth([may, april])[0]).toMatchObject({ key: '2026-05', label: '2026 年 5 月' })
  })

  it('summarizes run and strength activity metrics', () => {
    const runA = makeActivity({
      label_id: 'run-a',
      distance_km: 10,
      duration_s: 3000,
      avg_pace_s_km: 300,
      avg_hr: 140,
    })
    const runB = makeActivity({
      label_id: 'run-b',
      distance_km: 5,
      duration_s: 1800,
      avg_pace_s_km: 360,
      avg_hr: 156,
    })
    const strength = makeActivity({
      label_id: 'strength',
      sport_type: 402,
      sport_name: 'Strength Training',
      distance_km: 0,
      distance_m: 0,
      duration_s: 2100,
      avg_pace_s_km: null,
    })

    expect(summarizeActivities([runA, runB, strength])).toEqual({
      totalRunKm: 15,
      runDurationS: 4800,
      avgPaceSecPerKm: 320,
      avgRunHr: 146,
      strengthCount: 1,
      strengthDurationS: 2100,
    })
  })

  it('paginates activities with a fixed page size', () => {
    expect(paginateActivities(Array.from({ length: 13 }, (_, index) => makeActivity({ label_id: String(index) })), 2).items).toHaveLength(1)
  })

  it('returns the current Shanghai month date range', () => {
    expect(monthRangeFromShanghaiToday('2026-05-08')).toEqual({
      label: '2026 年 5 月',
      dateFrom: '2026-05-01',
      dateTo: '2026-05-31',
    })
  })

  it('formats duration and pace labels', () => {
    expect(formatHoursMinutes(3900)).toBe('1 小时 5 分')
    expect(formatPaceSeconds(320)).toBe("5'20\"")
    expect(formatPaceSeconds(null)).toBe('--')
  })
})
