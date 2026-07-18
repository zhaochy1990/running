import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyMasterPlanAdjustDiff,
  getActivities,
  getAllActivities,
  getCurrentMasterPlan,
  sendMasterPlanAdjustMessage,
  type Activity,
} from '../api'

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
      { method: 'GET', headers: {}, body: undefined },
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/user-1/activities?date_from=2026-05-01&date_to=2026-05-31&limit=200&offset=200',
      { method: 'GET', headers: {}, body: undefined },
    )
  })

  it('passes server-side pagination and filter parameters to the activity endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      total: 1,
      offset: 12,
      limit: 12,
      activities: [makeActivity(1)],
    })))

    const result = await getActivities('user-1', {
      limit: 12,
      offset: 12,
      sportCategory: 'run',
      minDistanceKm: 10,
    })

    expect(result.total).toBe(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/user-1/activities?limit=12&offset=12&sport_category=run&min_distance_km=10',
      { method: 'GET', headers: {}, body: undefined },
    )
  })
})

describe('master plan API clients', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('returns null when the current master plan endpoint has no active plan', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'not found' }), { status: 404 }))

    await expect(getCurrentMasterPlan()).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/users/me/master-plan/current', { method: 'GET', headers: {}, body: undefined })
  })

  it('posts adjust messages with history to the active master plan endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      ai_response: '已调整',
      diff: null,
    })))

    const response = await sendMasterPlanAdjustMessage('plan-1', '减量一周', [
      { role: 'assistant', content: '当前计划正常' },
    ])

    expect(response.data.ai_response).toBe('已调整')
    expect(fetchMock).toHaveBeenCalledWith('/api/users/me/master-plan/plan-1/adjust/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '减量一周',
        history: [{ role: 'assistant', content: '当前计划正常' }],
      }),
    })
  })

  it('posts accepted adjust diff operation ids to the apply endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      plan_id: 'plan-1',
      version: 3,
      updated_at: '2026-06-08T00:00:00Z',
      applied: 2,
      affected_weeks: [{ folder: '2026-06-08_06-14', reason: 'plan_adjusted' }],
    })))

    const diff = {
      diff_id: 'diff-1',
      plan_id: 'plan-1',
      ops: [],
      ai_explanation: '调整训练负荷',
      created_at: '2026-06-08T00:00:00Z',
    }
    const response = await applyMasterPlanAdjustDiff('plan-1', diff, ['op-1', 'op-2'], '调整训练负荷')

    expect(response.data.applied).toBe(2)
    expect(fetchMock).toHaveBeenCalledWith('/api/users/me/master-plan/plan-1/adjust/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        diff,
        accepted_op_ids: ['op-1', 'op-2'],
        change_reason: '调整训练负荷',
      }),
    })
  })
})
