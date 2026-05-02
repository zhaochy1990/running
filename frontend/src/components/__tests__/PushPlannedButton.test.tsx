import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import PushPlannedButton, { disabledReasonFor } from '../PushPlannedButton'
import type { PlannedSession, NormalizedRunWorkout, StructuredStatus } from '../../types/plan'

const RUN_SPEC: NormalizedRunWorkout = {
  schema: 'run-workout/v1',
  name: 'easy',
  date: '2026-04-20',
  note: null,
  blocks: [
    {
      repeat: 1,
      steps: [
        {
          step_kind: 'work',
          duration: { kind: 'distance_m', value: 10000 },
          target: { kind: 'pace_s_km', low: 360, high: 330 },
          note: null,
        },
      ],
    },
  ],
}

function makeSession(overrides: Partial<PlannedSession> = {}): PlannedSession {
  return {
    schema: 'plan-session/v1',
    date: '2026-04-20',
    session_index: 0,
    kind: 'run',
    summary: 'Easy 10km',
    spec: RUN_SPEC,
    notes_md: null,
    total_distance_m: 10000,
    total_duration_s: 3600,
    scheduled_workout_id: null,
    ...overrides,
  }
}

describe('disabledReasonFor', () => {
  it.each<[StructuredStatus, boolean]>([
    ['fresh', false],
    ['stale', true],
    ['parse_failed', true],
    ['backfilled', true],
    ['none', true],
  ])('status=%s → disabled=%s', (status, expected) => {
    const r = disabledReasonFor(makeSession(), status)
    expect(r.disabled).toBe(expected)
  })

  it('disables when session has no spec', () => {
    const r = disabledReasonFor(makeSession({ spec: null }), 'fresh')
    expect(r.disabled).toBe(true)
    expect(r.reason).toMatch(/没有完整 spec/)
  })

  it('disables when kind is rest even with status=fresh', () => {
    const r = disabledReasonFor(
      makeSession({ kind: 'rest', spec: null }),
      'fresh',
    )
    expect(r.disabled).toBe(true)
  })

  it('disables strength on fresh — current scope is run-only', () => {
    // We accept strength sessions can be pushable in plan_spec.py, but the
    // current push route is run-only. The button should reflect that.
    const r = disabledReasonFor(
      makeSession({ kind: 'strength', spec: null }),
      'fresh',
    )
    expect(r.disabled).toBe(true)
  })

  it('enables on fresh + run + spec, with no warning', () => {
    const r = disabledReasonFor(makeSession(), 'fresh')
    expect(r.disabled).toBe(false)
    expect(r.reason).toBeNull()
  })

  it('enables but warns on already-pushed session', () => {
    const r = disabledReasonFor(makeSession({ scheduled_workout_id: 42 }), 'fresh')
    expect(r.disabled).toBe(false)
    expect(r.reason).toMatch(/已推送/)
  })
})

describe('PushPlannedButton', () => {
  it('returns null when capability is not granted', () => {
    const { container } = render(
      <PushPlannedButton
        session={makeSession()}
        structuredStatus="fresh"
        canPushRun={false}
        onPush={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders disabled when status=backfilled', () => {
    render(
      <PushPlannedButton
        session={makeSession()}
        structuredStatus="backfilled"
        canPushRun={true}
        onPush={() => {}}
      />,
    )
    const btn = screen.getByRole('button', { name: '推送到手表' })
    expect(btn).toBeDisabled()
  })

  it('invokes onPush when fresh', async () => {
    const onPush = vi.fn().mockResolvedValue(undefined)
    render(
      <PushPlannedButton
        session={makeSession()}
        structuredStatus="fresh"
        canPushRun={true}
        onPush={onPush}
      />,
    )
    const btn = screen.getByRole('button', { name: '推送到手表' })
    expect(btn).not.toBeDisabled()
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(onPush).toHaveBeenCalledTimes(1)
  })

  it('shows "重新推送" label when already pushed', () => {
    render(
      <PushPlannedButton
        session={makeSession({ scheduled_workout_id: 42 })}
        structuredStatus="fresh"
        canPushRun={true}
        onPush={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: '重新推送' })).toBeInTheDocument()
  })
})
