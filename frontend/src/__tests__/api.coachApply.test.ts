/**
 * Pin the coach plan-apply API client contract: request shape (create vs diff
 * detection), the discriminated ApplyOutcome, and the 409 detail mapping —
 * season_impact_material -> needs_ack, "changed" -> stale, everything else ->
 * error. These wrappers wrap the raw backend proposal the chat stashed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const refreshMock = vi.hoisted(() => vi.fn())
vi.mock('../store/authStore', () => ({ refreshAccessToken: refreshMock }))

import { abandonCoachProposal, applyCoachMasterProposal, applyCoachWeekProposal } from '../api'

function resp(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  sessionStorage.clear()
  sessionStorage.setItem('access_token', 'tok-test')
  refreshMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

const diffRaw = {
  folder: '2026-07-13_07-19',
  base_revision: 'rev-abc',
  ops: [{ id: 'op-1' }, { id: 'op-2' }],
}
const createRaw = {
  folder: '2026-07-20_07-26',
  plan: { sessions: [{ day: 'mon' }] },
}

describe('applyCoachWeekProposal', () => {
  it('POSTs a diff proposal with accepted_op_ids + base_revision', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(200, { applied: 2, folder: 'f', created: false }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await applyCoachWeekProposal('2026-07-13_07-19', diffRaw, ['op-1', 'op-2'], 'rev-abc')

    expect(outcome.status).toBe('ok')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/users/me/coach/plan/2026-07-13_07-19/apply')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body.diff).toEqual(diffRaw)
    expect(body.proposal).toBeUndefined()
    expect(body.accepted_op_ids).toEqual(['op-1', 'op-2'])
    expect(body.base_revision).toBe('rev-abc')
    expect(body.session_id).toBe('web-default')
    expect(body.impact_acknowledgement).toBeUndefined()
  })

  it('sends a create proposal under `proposal`, not `diff`', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(200, { applied: 1, folder: 'f', created: true }))
    vi.stubGlobal('fetch', fetchMock)

    await applyCoachWeekProposal('2026-07-20_07-26', createRaw, [], 'rev-new')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.proposal).toEqual(createRaw)
    expect(body.diff).toBeUndefined()
  })

  it('forwards the weekly_only acknowledgement when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(200, { applied: 2 }))
    vi.stubGlobal('fetch', fetchMock)

    await applyCoachWeekProposal('f', diffRaw, ['op-1'], 'rev-abc', 'weekly_only')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.impact_acknowledgement).toBe('weekly_only')
  })

  it('maps 409 season_impact_material to needs_ack (not stale)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      resp(409, {
        detail: {
          code: 'season_impact_material',
          message: '该调整明显偏离赛季计划，需要确认仅改本周',
          season_impact: { level: 'material', reasons: ['挤压下周长距离'] },
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await applyCoachWeekProposal('f', diffRaw, ['op-1'], 'rev-abc')

    expect(outcome.status).toBe('needs_ack')
    if (outcome.status === 'needs_ack') {
      expect(outcome.seasonImpact).toContain('赛季')
    }
  })

  it('maps a 409 "changed" string detail to stale', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      resp(409, { detail: 'weekly plan changed since this proposal was created' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await applyCoachWeekProposal('f', diffRaw, ['op-1'], 'rev-abc')
    expect(outcome.status).toBe('stale')
  })

  it('maps other failures to error', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(500, { detail: 'boom' }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await applyCoachWeekProposal('f', diffRaw, ['op-1'], 'rev-abc')
    expect(outcome.status).toBe('error')
    if (outcome.status === 'error') expect(outcome.message).toBeTruthy()
  })
})

describe('applyCoachMasterProposal', () => {
  const masterRaw = { plan_id: 'plan-9', ops: [{ id: 'm-1' }, { id: 'm-2' }] }

  it('POSTs the diff with accepted_op_ids, change_reason, base_revision', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      resp(200, { applied: 2, plan_id: 'plan-9', version: 5, updated_at: 't', affected_weeks: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await applyCoachMasterProposal('plan-9', masterRaw, ['m-1', 'm-2'], '4')

    expect(outcome.status).toBe('ok')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/users/me/coach/master-plan/plan-9/apply')
    const body = JSON.parse(init.body as string)
    expect(body.diff).toEqual(masterRaw)
    expect(body.accepted_op_ids).toEqual(['m-1', 'm-2'])
    expect(body.base_revision).toBe('4')
    expect(body.session_id).toBe('web-default')
    expect(typeof body.change_reason).toBe('string')
  })

  it('maps 409 "changed" to stale', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      resp(409, { detail: 'master plan changed since this proposal was created' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await applyCoachMasterProposal('plan-9', masterRaw, ['m-1'], '4')
    expect(outcome.status).toBe('stale')
  })

  it('maps other failures to error', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(422, { detail: 'bad' }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await applyCoachMasterProposal('plan-9', masterRaw, ['m-1'], '4')
    expect(outcome.status).toBe('error')
  })
})

describe('abandonCoachProposal', () => {
  it('records a weekly abandonment as a trusted event', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      resp(200, { recorded: true, created_at: '2026-07-18T00:00:00Z' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await abandonCoachProposal({ kind: 'weekly', folder: '2026-07-13_07-19' })

    expect(result).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/users/me/coach/proposals/abandon')
    expect(JSON.parse(init.body as string)).toEqual({
      session_id: 'web-default',
      target: { kind: 'week', folder: '2026-07-13_07-19' },
      summary: '用户放弃了本次调整方案',
    })
  })

  it('records a master-plan abandonment with the canonical target shape', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      resp(200, { recorded: true, created_at: '2026-07-18T00:00:00Z' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await abandonCoachProposal({ kind: 'master', planId: 'plan-9' })

    expect(result).toBe(true)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).target).toEqual({
      kind: 'master',
      plan_id: 'plan-9',
    })
  })

  it('returns false when the trusted-event endpoint rejects the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(resp(503, { detail: 'unavailable' })))

    await expect(
      abandonCoachProposal({ kind: 'weekly', folder: '2026-07-13_07-19' }),
    ).resolves.toBe(false)
  })
})
