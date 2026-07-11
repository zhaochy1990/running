import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import PlanVsActualCard, { judgeNumeric } from '../PlanVsActualCard'
import type { Activity } from '../../api'
import type { PlannedSession, NormalizedRunWorkout } from '../../types/plan'

describe('judgeNumeric', () => {
  it('returns green for actual inside band', () => {
    const r = judgeNumeric(345, 360, 330, true) // pace
    expect(r.adherence).toBe('green')
  })

  it('returns red for distance >15% off', () => {
    // plan ~10km, actual 5km
    const r = judgeNumeric(5000, 9500, 10500)
    expect(r.adherence).toBe('red')
  })

  it('returns amber for ~10% off midpoint', () => {
    const r = judgeNumeric(11000, 9500, 10500) // ~10% over the midpoint 10000
    expect(r.adherence).toBe('amber')
  })

  it('returns green when both actual and target are unknown', () => {
    expect(judgeNumeric(null, null, null).adherence).toBe('green')
  })
})

const RUN_SPEC: NormalizedRunWorkout = {
  schema: 'run-workout/v1',
  name: 'long run',
  date: '2026-04-20',
  note: null,
  blocks: [
    {
      repeat: 1,
      steps: [
        {
          step_kind: 'work',
          duration: { kind: 'distance_m', value: 20000 },
          target: { kind: 'pace_s_km', low: 360, high: 330 },
          note: null,
        },
        {
          step_kind: 'work',
          duration: { kind: 'distance_m', value: 0 },
          target: { kind: 'hr_bpm', low: 140, high: 160 },
          note: null,
        },
      ],
    },
  ],
}

const session: PlannedSession = {
  schema: 'plan-session/v1',
  date: '2026-04-20',
  session_index: 0,
  kind: 'run',
  summary: 'Long run 20km',
  spec: RUN_SPEC,
  notes_md: null,
  total_distance_m: 20000,
  total_duration_s: 7200,
  scheduled_workout_id: null,
}

function makeActivity(overrides: Partial<Activity>): Activity {
  return {
    label_id: 'abc',
    name: '20km',
    sport_type: 8,
    sport_name: 'Run',
    date: '2026-04-20T07:00:00+08:00',
    distance_m: 20000,
    distance_km: 20,
    duration_s: 7200,
    duration_fmt: '2:00:00',
    avg_pace_s_km: 360,
    pace_fmt: '6:00/km',
    avg_hr: 150,
    max_hr: 170,
    avg_cadence: 180,
    calories_kcal: 1500,
    training_load: 200,
    vo2max: 60,
    train_type: 'Aerobic Endurance',
    ascent_m: 50,
    aerobic_effect: 3.5,
    anaerobic_effect: 0.5,
    temperature: 18,
    humidity: 60,
    feels_like: 18,
    wind_speed: 5,
    feel_type: 2,
    sport_note: null,
    ...overrides,
  }
}

describe('PlanVsActualCard', () => {
  it('renders all three rows with adherence styling', () => {
    render(<PlanVsActualCard session={session} activity={makeActivity({})} />)
    expect(screen.getByTestId('plan-vs-actual-card')).toBeInTheDocument()
    expect(screen.getByTestId('adherence-距离')).toBeInTheDocument()
    expect(screen.getByTestId('adherence-平均配速')).toBeInTheDocument()
    expect(screen.getByTestId('adherence-平均心率')).toBeInTheDocument()
  })

  it('marks distance red when actual is half the plan', () => {
    const { container } = render(
      <PlanVsActualCard
        session={session}
        activity={makeActivity({ distance_m: 10000, distance_km: 10 })}
      />,
    )
    const node = container.querySelector('.adherence-red')
    expect(node).not.toBeNull()
  })

  it('marks pace green when inside target band', () => {
    const { container } = render(
      <PlanVsActualCard
        session={session}
        activity={makeActivity({ avg_pace_s_km: 345 })}
      />,
    )
    const greens = container.querySelectorAll('.adherence-green')
    expect(greens.length).toBeGreaterThan(0)
  })
})
