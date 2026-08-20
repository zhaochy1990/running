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

  it('parses the Markdown current season-plan envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      content_version: 1,
      status: 'active',
      plan_id: 'plan-markdown',
      goal_id: 'goal-1',
      revision: null,
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z',
      plan: '# Markdown season plan',
    })))

    const result = await getCurrentMasterPlan('user-1')

    expect(result?.content_version).toBe(1)
    if (result?.content_version !== 1) throw new Error('expected Markdown plan')
    expect(result.plan).toBe('# Markdown season plan')
    expect(result.revision).toBeNull()
  })

  it('parses the structured current season-plan envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      content_version: 2,
      status: 'active',
      plan_id: 'plan-structured',
      goal_id: 'goal-1',
      revision: 3,
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z',
      plan: {
        goal: { goal_id: 'goal-1', race_name: '目标马拉松', distance: 'FM', race_date: '2026-10-11', target_time: '03:15:00', timezone: 'Asia/Shanghai' },
        start_date: '2026-05-04',
        end_date: '2026-10-11',
        total_weeks: 23,
        phases: [],
        milestones: [],
        weeks: [],
        training_principles: ['逐步加量'],
        generated_by: 'planner',
        current_phase_id: null,
        current_week_number: null,
        next_milestone: null,
      },
    })))

    const result = await getCurrentMasterPlan('user-1')

    expect(result?.content_version).toBe(2)
    if (result?.content_version !== 2) throw new Error('expected structured plan')
    expect(result.plan.goal.goal_id).toBe('goal-1')
    expect(result.revision).toBe(3)
  })

  it('returns null only when the current season-plan endpoint returns 404', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'not found' }), { status: 404 }))

    await expect(getCurrentMasterPlan('user-1')).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/users/user-1/master-plan/current', { method: 'GET', headers: {}, body: undefined })
  })

  it.each([
    ['invalid revision', {
      content_version: 2,
      status: 'active',
      plan_id: 'plan-structured',
      goal_id: 'goal-1',
      revision: null,
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z',
      plan: {},
    }],
    ['malformed nested content', {
      content_version: 2,
      status: 'active',
      plan_id: 'plan-structured',
      goal_id: 'goal-1',
      revision: 1,
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z',
      plan: {
        goal: { goal_id: 'goal-1' },
        start_date: '2026-05-04',
        end_date: '2026-10-11',
        total_weeks: 23,
        phases: [{ id: 'phase-with-missing-fields' }],
        milestones: [],
        weeks: [],
        training_principles: ['逐步加量'],
        generated_by: 'planner',
        current_phase_id: null,
        current_week_number: null,
        next_milestone: null,
      },
    }],
  ])('rejects %s in current season-plan envelopes', async (_case, payload) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(payload)))

    await expect(getCurrentMasterPlan('user-1')).rejects.toThrow('Invalid current season plan')
  })

  it.each([
    { status: 'available', unavailable_reason: 'planned_session_uncomputable' },
    { status: 'unavailable', unavailable_reason: 'unexpected_reason' },
    { status: 'unavailable', unavailable_reason: null },
  ])('rejects invalid training-load projection %#', async (projection) => {
    const plan = {
      content_version: 2,
      status: 'active',
      plan_id: 'plan-structured',
      goal_id: 'goal-1',
      revision: 1,
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z',
      plan: {
        goal: { goal_id: 'goal-1', race_name: '目标马拉松', distance: 'FM', race_date: '2026-10-11', target_time: '03:15:00', timezone: 'Asia/Shanghai' },
        start_date: '2026-05-04', end_date: '2026-10-11', total_weeks: 23,
        phases: [], milestones: [], weeks: [], training_principles: ['逐步加量'], generated_by: 'planner',
        current_phase_id: null, current_week_number: null, next_milestone: null,
        training_load_projection: { ...projection, calculated_at: '2026-05-01T00:00:00Z' },
      },
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(plan)))
    await expect(getCurrentMasterPlan('user-1')).rejects.toThrow('Invalid current season plan')
  })

  it('rejects non-404 current season-plan failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'internal error' }),
      { status: 500 },
    ))

    await expect(getCurrentMasterPlan('user-1')).rejects.toMatchObject({ status: 500 })
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
