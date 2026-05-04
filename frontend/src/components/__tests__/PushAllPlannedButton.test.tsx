import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import PushAllPlannedButton, { pushableSessionsFor } from '../PushAllPlannedButton'
import type {
  NormalizedRunWorkout,
  NormalizedStrengthWorkout,
  PlannedSession,
} from '../../types/plan'

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

const STRENGTH_SPEC: NormalizedStrengthWorkout = {
  schema: 'strength-workout/v1',
  name: 'core',
  date: '2026-04-21',
  note: null,
  exercises: [
    {
      canonical_id: 'plank_basic',
      display_name: '平板支撑',
      sets: 3,
      target_kind: 'time_s',
      target_value: 45,
      rest_seconds: 30,
      note: null,
    },
  ],
}

function makeRun(overrides: Partial<PlannedSession> = {}): PlannedSession {
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

function makeStrength(overrides: Partial<PlannedSession> = {}): PlannedSession {
  return {
    schema: 'plan-session/v1',
    date: '2026-04-21',
    session_index: 0,
    kind: 'strength',
    summary: 'Core 3×',
    spec: STRENGTH_SPEC,
    notes_md: null,
    total_distance_m: null,
    total_duration_s: null,
    scheduled_workout_id: null,
    ...overrides,
  }
}

function makeRest(overrides: Partial<PlannedSession> = {}): PlannedSession {
  return {
    schema: 'plan-session/v1',
    date: '2026-04-22',
    session_index: 0,
    kind: 'rest',
    summary: '完全休息',
    spec: null,
    notes_md: null,
    total_distance_m: null,
    total_duration_s: null,
    scheduled_workout_id: null,
    ...overrides,
  }
}

describe('pushableSessionsFor', () => {
  it('keeps run sessions when canPushRun=true and not yet pushed', () => {
    const list = pushableSessionsFor([makeRun()], true, true)
    expect(list).toHaveLength(1)
  })

  it('drops run sessions when canPushRun=false', () => {
    const list = pushableSessionsFor([makeRun()], false, true)
    expect(list).toEqual([])
  })

  it('drops strength sessions when canPushStrength=false (Garmin path)', () => {
    const list = pushableSessionsFor([makeStrength()], true, false)
    expect(list).toEqual([])
  })

  it('drops sessions that are already pushed', () => {
    const list = pushableSessionsFor(
      [makeRun({ scheduled_workout_id: 99 })],
      true,
      true,
    )
    expect(list).toEqual([])
  })

  it('drops sessions without a spec', () => {
    const list = pushableSessionsFor([makeRun({ spec: null })], true, true)
    expect(list).toEqual([])
  })

  it('drops rest/cross/note kinds', () => {
    const list = pushableSessionsFor([makeRest()], true, true)
    expect(list).toEqual([])
  })
})

describe('PushAllPlannedButton', () => {
  it('renders button with the count of pushable sessions', () => {
    render(
      <PushAllPlannedButton
        sessions={[makeRun(), makeStrength(), makeRest()]}
        structuredStatus="fresh"
        canPushRun
        canPushStrength
        onPush={() => Promise.resolve()}
      />,
    )
    expect(
      screen.getByRole('button', { name: '一键推送本周训练' }),
    ).toHaveTextContent('一键推送 (2)')
  })

  it('returns null when status is parse_failed', () => {
    const { container } = render(
      <PushAllPlannedButton
        sessions={[makeRun()]}
        structuredStatus="parse_failed"
        canPushRun
        onPush={() => Promise.resolve()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('returns null when no eligible sessions exist (all rest)', () => {
    const { container } = render(
      <PushAllPlannedButton
        sessions={[makeRest()]}
        structuredStatus="fresh"
        canPushRun
        onPush={() => Promise.resolve()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows "全部已推送" when every eligible session has scheduled_workout_id', () => {
    render(
      <PushAllPlannedButton
        sessions={[makeRun({ scheduled_workout_id: 1 })]}
        structuredStatus="fresh"
        canPushRun
        onPush={() => Promise.resolve()}
      />,
    )
    const btn = screen.getByRole('button', { name: '全部已推送' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveTextContent('✓ 全部已推送')
  })

  it('calls onPush sequentially for each pushable session', async () => {
    const calls: string[] = []
    const onPush = vi.fn(async (s: PlannedSession) => {
      calls.push(`${s.date}#${s.session_index}`)
    })
    render(
      <PushAllPlannedButton
        sessions={[
          makeRun({ date: '2026-04-20', session_index: 0 }),
          makeRun({ date: '2026-04-22', session_index: 0 }),
          makeStrength({ date: '2026-04-21', session_index: 1 }),
        ]}
        structuredStatus="fresh"
        canPushRun
        canPushStrength
        onPush={onPush}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('push-all-button'))
    })

    expect(onPush).toHaveBeenCalledTimes(3)
    expect(calls).toEqual([
      '2026-04-20#0',
      '2026-04-22#0',
      '2026-04-21#1',
    ])
  })

  it('reports failure summary when some pushes throw', async () => {
    const onPush = vi.fn(async (s: PlannedSession) => {
      if (s.date === '2026-04-22') throw new Error('boom')
    })
    render(
      <PushAllPlannedButton
        sessions={[
          makeRun({ date: '2026-04-20', session_index: 0 }),
          makeRun({ date: '2026-04-22', session_index: 0 }),
        ]}
        structuredStatus="fresh"
        canPushRun
        onPush={onPush}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('push-all-button'))
    })

    const results = screen.getByTestId('push-all-results')
    expect(results).toHaveTextContent('成功 1')
    expect(results).toHaveTextContent('失败 1')
    expect(results).toHaveTextContent('boom')
  })

  it('signals batch start/end via onBatchStateChange', async () => {
    const onBatchStateChange = vi.fn()
    render(
      <PushAllPlannedButton
        sessions={[makeRun()]}
        structuredStatus="fresh"
        canPushRun
        onPush={() => Promise.resolve()}
        onBatchStateChange={onBatchStateChange}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('push-all-button'))
    })

    expect(onBatchStateChange).toHaveBeenNthCalledWith(1, true)
    expect(onBatchStateChange).toHaveBeenLastCalledWith(false)
  })
})
