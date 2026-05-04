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
    ['authored', false],
    ['stale', true],
    ['parse_failed', true],
    ['backfilled', true],
    ['none', true],
  ])('status=%s → disabled=%s', (status, expected) => {
    const r = disabledReasonFor(makeSession(), status)
    expect(r.disabled).toBe(expected)
  })

  it('enables on authored + run + spec, with no warning', () => {
    const r = disabledReasonFor(makeSession(), 'authored')
    expect(r.disabled).toBe(false)
    expect(r.reason).toBeNull()
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

  it('disables strength when its spec is null even on fresh', () => {
    // Strength is now pushable in scope, but only if it carries a spec.
    const r = disabledReasonFor(
      makeSession({ kind: 'strength', spec: null }),
      'fresh',
    )
    expect(r.disabled).toBe(true)
    expect(r.reason).toMatch(/没有完整 spec/)
  })

  it('enables strength on fresh + spec present', () => {
    const r = disabledReasonFor(
      makeSession({ kind: 'strength' }),
      'fresh',
    )
    expect(r.disabled).toBe(false)
    expect(r.reason).toBeNull()
  })

  it('disables rest kind regardless of capabilities', () => {
    // Rest sessions have no spec (isPushable returns false). The first gate
    // fires on the spec check rather than the kind check.
    const r = disabledReasonFor(
      makeSession({ kind: 'rest', spec: null }),
      'fresh',
    )
    expect(r.disabled).toBe(true)
    expect(r.reason).toMatch(/没有完整 spec/)
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

  it('shows "已推送" success label when already pushed', () => {
    render(
      <PushPlannedButton
        session={makeSession({ scheduled_workout_id: 42 })}
        structuredStatus="fresh"
        canPushRun={true}
        onPush={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: '✓ 已推送' })).toBeInTheDocument()
  })

  it('renders strength push button when canPushStrength=true', () => {
    render(
      <PushPlannedButton
        session={makeSession({ kind: 'strength' })}
        structuredStatus="fresh"
        canPushRun={false}
        canPushStrength={true}
        onPush={() => {}}
      />,
    )
    const btn = screen.getByRole('button', { name: '推送到手表' })
    expect(btn).not.toBeDisabled()
  })

  it('hides strength button when canPushStrength=false', () => {
    const { container } = render(
      <PushPlannedButton
        session={makeSession({ kind: 'strength' })}
        structuredStatus="fresh"
        canPushRun={true}
        canPushStrength={false}
        onPush={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('strength button defaults to canPushRun when canPushStrength omitted', () => {
    render(
      <PushPlannedButton
        session={makeSession({ kind: 'strength' })}
        structuredStatus="fresh"
        canPushRun={true}
        onPush={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: '推送到手表' })).toBeInTheDocument()
  })
})
