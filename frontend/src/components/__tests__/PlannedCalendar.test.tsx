import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import PlannedCalendar from '../PlannedCalendar'
import type { PlannedSession, NormalizedRunWorkout } from '../../types/plan'

const WEEK_DATES = [
  '2026-04-20',
  '2026-04-21',
  '2026-04-22',
  '2026-04-23',
  '2026-04-24',
  '2026-04-25',
  '2026-04-26',
]

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
          note: 'Conversational',
        },
      ],
    },
  ],
}

const sessions: PlannedSession[] = [
  {
    schema: 'plan-session/v1',
    date: '2026-04-20',
    session_index: 0,
    kind: 'run',
    summary: 'Easy 10km',
    spec: RUN_SPEC,
    notes_md: 'RPE 3',
    total_distance_m: 10000,
    total_duration_s: 3600,
    scheduled_workout_id: null,
  },
  {
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
  },
]

describe('PlannedCalendar', () => {
  it('renders 7 day-cards even when only some have sessions', () => {
    render(
      <PlannedCalendar
        weekDates={WEEK_DATES}
        sessions={sessions}
        nutrition={[]}
        structuredStatus="fresh"
        canPushRun={true}
        onPush={() => {}}
      />,
    )
    const cards = screen.getAllByTestId('day-card')
    expect(cards).toHaveLength(7)
    // Dates render in order.
    expect(cards.map((c) => c.dataset.date)).toEqual(WEEK_DATES)
  })

  it('shows backfill banner when status=backfilled', () => {
    render(
      <PlannedCalendar
        weekDates={WEEK_DATES}
        sessions={sessions}
        nutrition={[]}
        structuredStatus="backfilled"
        canPushRun={true}
        onPush={() => {}}
      />,
    )
    expect(screen.getByTestId('backfill-banner')).toBeInTheDocument()
  })

  it('shows empty fallback when status=parse_failed', () => {
    render(
      <PlannedCalendar
        weekDates={WEEK_DATES}
        sessions={sessions}
        nutrition={[]}
        structuredStatus="parse_failed"
        canPushRun={true}
        onPush={() => {}}
      />,
    )
    expect(screen.getByTestId('planned-calendar-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('day-card')).not.toBeInTheDocument()
  })

  it('renders RPE label when found in summary or notes', () => {
    render(
      <PlannedCalendar
        weekDates={WEEK_DATES}
        sessions={sessions}
        nutrition={[]}
        structuredStatus="fresh"
        canPushRun={true}
        onPush={() => {}}
      />,
    )
    expect(screen.getByText('RPE 3')).toBeInTheDocument()
  })

  it('renders nutrition row when kcal_target provided', () => {
    render(
      <PlannedCalendar
        weekDates={WEEK_DATES}
        sessions={sessions}
        nutrition={[
          {
            schema: 'plan-nutrition/v1',
            date: '2026-04-20',
            kcal_target: 2400,
            carbs_g: 300,
            protein_g: 130,
            fat_g: 75,
            water_ml: 2500,
            meals: [],
            notes_md: null,
          },
        ]}
        structuredStatus="fresh"
        canPushRun={true}
        onPush={() => {}}
      />,
    )
    const nut = screen.getByTestId('nutrition-row')
    expect(nut.textContent).toContain('2400 kcal')
    expect(nut.textContent).toContain('蛋 130g')
  })
})
