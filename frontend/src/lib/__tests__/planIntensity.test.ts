import { describe, expect, it } from 'vitest'
import {
  classifySessionByText,
  classifyStep,
  computeWeekPlanIntensity,
} from '../planIntensity'
import type {
  NormalizedRunWorkout,
  PlannedSession,
  WorkoutStep,
} from '../../types/plan'

function step(overrides: Partial<WorkoutStep>): WorkoutStep {
  return {
    step_kind: 'work',
    duration: { kind: 'distance_m', value: 1000 },
    target: { kind: 'open', low: null, high: null },
    note: null,
    ...overrides,
  }
}

function makeRunSession(overrides: Partial<PlannedSession> = {}): PlannedSession {
  return {
    schema: 'plan-session/v1',
    date: '2026-04-20',
    session_index: 0,
    kind: 'run',
    summary: 'Easy 10km',
    spec: null,
    notes_md: null,
    total_distance_m: 10000,
    total_duration_s: 3600,
    scheduled_workout_id: null,
    ...overrides,
  }
}

describe('classifyStep', () => {
  it('warmup/cooldown/recovery → low regardless of target', () => {
    expect(classifyStep(step({ step_kind: 'warmup' }))).toBe('low')
    expect(classifyStep(step({ step_kind: 'cooldown' }))).toBe('low')
    expect(classifyStep(step({ step_kind: 'recovery' }))).toBe('low')
  })

  it('hr_bpm classifies by avg', () => {
    expect(
      classifyStep(step({ target: { kind: 'hr_bpm', low: 130, high: 140 } })),
    ).toBe('low')
    expect(
      classifyStep(step({ target: { kind: 'hr_bpm', low: 158, high: 162 } })),
    ).toBe('mid')
    expect(
      classifyStep(step({ target: { kind: 'hr_bpm', low: 170, high: 180 } })),
    ).toBe('high')
  })

  it('pace_s_km classifies by avg (lower s/km = faster = higher)', () => {
    // 5:00/km avg → low
    expect(
      classifyStep(step({ target: { kind: 'pace_s_km', low: 290, high: 310 } })),
    ).toBe('low')
    // 4:15/km avg → mid
    expect(
      classifyStep(step({ target: { kind: 'pace_s_km', low: 250, high: 260 } })),
    ).toBe('mid')
    // 3:45/km avg → high
    expect(
      classifyStep(step({ target: { kind: 'pace_s_km', low: 220, high: 230 } })),
    ).toBe('high')
  })

  it('open target on work step → mid', () => {
    expect(classifyStep(step({ target: { kind: 'open', low: null, high: null } }))).toBe('mid')
  })
})

describe('classifySessionByText', () => {
  it('uses RPE when present', () => {
    expect(classifySessionByText(makeRunSession({ summary: 'X', notes_md: 'RPE 3' }))).toBe('low')
    expect(classifySessionByText(makeRunSession({ summary: 'X', notes_md: 'RPE 5' }))).toBe('mid')
    expect(classifySessionByText(makeRunSession({ summary: 'X', notes_md: 'RPE 8' }))).toBe('high')
  })

  it('falls back to summary keywords', () => {
    expect(classifySessionByText(makeRunSession({ summary: '轻松 10km' }))).toBe('low')
    expect(classifySessionByText(makeRunSession({ summary: '间歇 8×400m' }))).toBe('high')
    expect(classifySessionByText(makeRunSession({ summary: 'tempo 8km' }))).toBe('mid')
  })
})

describe('computeWeekPlanIntensity', () => {
  it('returns zeros for empty input', () => {
    expect(computeWeekPlanIntensity([])).toEqual({
      total_km: 0,
      low_km: 0,
      mid_km: 0,
      high_km: 0,
    })
  })

  it('skips non-run sessions', () => {
    const r = computeWeekPlanIntensity([
      makeRunSession({ kind: 'strength', total_distance_m: null }),
      makeRunSession({ kind: 'rest', total_distance_m: null }),
    ])
    expect(r.total_km).toBe(0)
  })

  it('attributes whole session by text when no spec', () => {
    const r = computeWeekPlanIntensity([
      makeRunSession({ summary: '轻松跑 10km', total_distance_m: 10000 }),
      makeRunSession({
        date: '2026-04-22',
        summary: '间歇 5km',
        total_distance_m: 5000,
      }),
    ])
    expect(r.total_km).toBe(15)
    expect(r.low_km).toBe(10)
    expect(r.high_km).toBe(5)
    expect(r.mid_km).toBe(0)
  })

  it('uses step-level breakdown when spec is provided', () => {
    // Interval session: 2km warmup + 5×(1km @ Z4) + 1km cooldown = 8km total
    // Expect: low = warmup+cooldown = 3km, high = 5×1 = 5km, mid = 0
    const intervalSpec: NormalizedRunWorkout = {
      schema: 'run-workout/v1',
      name: 'intervals',
      date: '2026-04-22',
      note: null,
      blocks: [
        {
          repeat: 1,
          steps: [
            step({
              step_kind: 'warmup',
              duration: { kind: 'distance_m', value: 2000 },
            }),
          ],
        },
        {
          repeat: 5,
          steps: [
            step({
              step_kind: 'work',
              duration: { kind: 'distance_m', value: 1000 },
              target: { kind: 'hr_bpm', low: 170, high: 180 },
            }),
          ],
        },
        {
          repeat: 1,
          steps: [
            step({
              step_kind: 'cooldown',
              duration: { kind: 'distance_m', value: 1000 },
            }),
          ],
        },
      ],
    }
    const r = computeWeekPlanIntensity([
      makeRunSession({
        date: '2026-04-22',
        summary: 'Intervals',
        spec: intervalSpec,
        total_distance_m: 8000,
      }),
    ])
    expect(r.total_km).toBe(8)
    expect(r.low_km).toBe(3)
    expect(r.high_km).toBe(5)
    expect(r.mid_km).toBe(0)
  })

  it('proportionally scales spec breakdown to session total when they differ', () => {
    // Spec only sums to 5km but session total_distance_m says 6km — scale up.
    const spec: NormalizedRunWorkout = {
      schema: 'run-workout/v1',
      name: 'mix',
      date: '2026-04-22',
      note: null,
      blocks: [
        {
          repeat: 1,
          steps: [
            step({
              step_kind: 'warmup',
              duration: { kind: 'distance_m', value: 2000 },
            }),
            step({
              step_kind: 'work',
              duration: { kind: 'distance_m', value: 3000 },
              target: { kind: 'hr_bpm', low: 170, high: 180 },
            }),
          ],
        },
      ],
    }
    const r = computeWeekPlanIntensity([
      makeRunSession({ spec, total_distance_m: 6000 }),
    ])
    expect(r.total_km).toBe(6)
    // 2/5 warmup → low = 6 × 2/5 = 2.4; 3/5 high = 6 × 3/5 = 3.6
    expect(r.low_km).toBe(2.4)
    expect(r.high_km).toBe(3.6)
  })

  it('aggregates a realistic mixed week', () => {
    const easySpec: NormalizedRunWorkout = {
      schema: 'run-workout/v1',
      name: 'easy',
      date: '2026-04-20',
      note: null,
      blocks: [
        {
          repeat: 1,
          steps: [
            step({
              step_kind: 'work',
              duration: { kind: 'distance_m', value: 10000 },
              target: { kind: 'hr_bpm', low: 130, high: 145 },
            }),
          ],
        },
      ],
    }
    const intervalSpec: NormalizedRunWorkout = {
      schema: 'run-workout/v1',
      name: 'i',
      date: '2026-04-22',
      note: null,
      blocks: [
        {
          repeat: 1,
          steps: [
            step({
              step_kind: 'warmup',
              duration: { kind: 'distance_m', value: 2000 },
            }),
          ],
        },
        {
          repeat: 6,
          steps: [
            step({
              step_kind: 'work',
              duration: { kind: 'distance_m', value: 400 },
              target: { kind: 'pace_s_km', low: 215, high: 225 },
            }),
            step({
              step_kind: 'recovery',
              duration: { kind: 'distance_m', value: 200 },
            }),
          ],
        },
        {
          repeat: 1,
          steps: [
            step({
              step_kind: 'cooldown',
              duration: { kind: 'distance_m', value: 1500 },
            }),
          ],
        },
      ],
    }
    const r = computeWeekPlanIntensity([
      makeRunSession({
        date: '2026-04-20',
        spec: easySpec,
        total_distance_m: 10000,
      }),
      makeRunSession({
        date: '2026-04-22',
        spec: intervalSpec,
        total_distance_m: 7100, // 2 + 6×0.6 + 1.5 = 7.1
      }),
      makeRunSession({
        date: '2026-04-24',
        summary: '长距离 20km',
        spec: null,
        total_distance_m: 20000,
      }),
    ])
    // Total: 10 + 7.1 + 20 = 37.1
    expect(r.total_km).toBeCloseTo(37.1, 1)
    // Low: 10 (easy run hr_bpm @ 137.5) + (warmup 2 + recovery 1.2 + cooldown 1.5) + 20 (长距离) = 34.7
    expect(r.low_km).toBeCloseTo(34.7, 1)
    // High: interval work = 6×0.4 = 2.4
    expect(r.high_km).toBeCloseTo(2.4, 1)
    // Mid: 0
    expect(r.mid_km).toBeCloseTo(0, 1)
  })
})
