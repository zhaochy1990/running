import { describe, expect, it } from 'vitest'
import type { Activity } from '../../api'
import { actualRunDistanceKm, actualStrengthStats, formatDurationClock } from '../weeklyPlanView'

function activity(overrides: Partial<Activity>): Activity {
  return {
    label_id: 'activity',
    name: null,
    sport_type: 100,
    sport_name: 'Run',
    date: '2026-07-13T00:00:00+08:00',
    distance_m: 8000,
    distance_km: 8,
    duration_s: 3000,
    duration_fmt: '50m',
    avg_pace_s_km: 375,
    pace_fmt: "6'15\"",
    avg_hr: 140,
    max_hr: 160,
    avg_cadence: 176,
    calories_kcal: 500,
    training_load: 60,
    vo2max: null,
    train_type: null,
    ascent_m: 20,
    aerobic_effect: null,
    anaerobic_effect: null,
    temperature: null,
    humidity: null,
    feels_like: null,
    wind_speed: null,
    feel_type: null,
    sport_note: null,
    ...overrides,
  }
}

describe('weeklyPlanView', () => {
  it('only counts running distance toward weekly mileage completion', () => {
    const activities = [
      activity({ label_id: 'run', distance_km: 8 }),
      activity({ label_id: 'strength', sport_type: 402, sport_name: 'Strength Training', distance_km: 1.2 }),
      activity({ label_id: 'ride', sport_type: 200, sport_name: 'Bike', distance_km: 25 }),
    ]

    expect(actualRunDistanceKm(activities)).toBe(8)
  })

  it('summarizes actual strength count and duration', () => {
    const activities = [
      activity({ label_id: 'run', duration_s: 3600 }),
      activity({ label_id: 'strength-1', sport_type: 402, sport_name: 'Strength Training', duration_s: 1800 }),
      activity({ label_id: 'strength-2', sport_type: 800, sport_name: 'Strength', duration_s: 2750 }),
    ]

    expect(actualStrengthStats(activities)).toEqual({ count: 2, durationS: 4550 })
    expect(formatDurationClock(4550)).toBe('01:15:50')
  })
})
