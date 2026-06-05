import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getAllActivities, type Activity } from '../api'

function makeActivity(index: number): Activity {
  return {
    label_id: `activity-${index}`,
    name: `Activity ${index}`,
    sport_type: 100,
    sport_name: 'Run',
    date: '2026-05-01T06:00:00+08:00',
    distance_m: 10000,
    distance_km: 10,
    duration_s: 3000,
    duration_fmt: '00:50:00',
    avg_pace_s_km: 300,
    pace_fmt: '5:00/km',
    avg_hr: 145,
    max_hr: 170,
    avg_cadence: 180,
    calories_kcal: 500,
    training_load: 120,
    vo2max: null,
    train_type: null,
    ascent_m: null,
    aerobic_effect: null,
    anaerobic_effect: null,
    temperature: null,
    humidity: null,
    feels_like: null,
    wind_speed: null,
    feel_type: null,
    sport_note: null,
    pauses: [],
    route_thumb: null,
  }
}

describe('getAllActivities', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('fetches all pages for a date range', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        total: 250,
        offset: 0,
        limit: 200,
        activities: Array.from({ length: 200 }, (_, index) => makeActivity(index)),
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        total: 250,
        offset: 200,
        limit: 200,
        activities: Array.from({ length: 50 }, (_, index) => makeActivity(index + 200)),
      })))

    const result = await getAllActivities('user-1', { dateFrom: '2026-05-01', dateTo: '2026-05-31' })

    expect(result).toHaveLength(250)
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/user-1/activities?date_from=2026-05-01&date_to=2026-05-31&limit=200&offset=0',
      { headers: {} },
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/user-1/activities?date_from=2026-05-01&date_to=2026-05-31&limit=200&offset=200',
      { headers: {} },
    )
  })
})
