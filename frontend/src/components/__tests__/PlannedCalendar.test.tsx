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

  it('shows hr_cap_bpm next to the work pace target (HR ≤N)', () => {
    // Path C of the calendar HR fix: parser populates hr_cap_bpm on the
    // work step when the plan specifies "pace + HR ceiling". The card
    // should surface "HR ≤167" alongside the pace.
    const tempoSession: PlannedSession = {
      schema: 'plan-session/v1',
      date: '2026-04-22',
      session_index: 0,
      kind: 'run',
      summary: 'Tempo 4×3K',
      notes_md: null,
      total_distance_m: 14500,
      total_duration_s: null,
      scheduled_workout_id: null,
      spec: {
        schema: 'run-workout/v1',
        name: 't',
        date: '2026-04-22',
        note: null,
        blocks: [
          {
            repeat: 4,
            steps: [
              {
                step_kind: 'work',
                duration: { kind: 'distance_m', value: 3000 },
                target: { kind: 'pace_s_km', low: 250, high: 245 },
                hr_cap_bpm: 167,
                note: null,
              },
            ],
          },
        ],
      },
    }

    render(
      <PlannedCalendar
        weekDates={WEEK_DATES}
        sessions={[tempoSession]}
        nutrition={[]}
        structuredStatus="fresh"
        canPushRun={true}
        onPush={() => {}}
      />,
    )

    expect(screen.getByText(/4:05.*4:10/)).toBeInTheDocument()
    expect(screen.getByText(/HR ≤167/)).toBeInTheDocument()
  })

  it('shows the WORK step pace/HR target, not warmup/cooldown', () => {
    // Regression for the 5/4-5/10 W2 calendar bug: an interval session has
    // warmup HR 130-150 and a 4×3K work block at pace 4:05-4:10/km. The
    // header should surface the work-step pace, not the warmup HR.
    const intervalSession: PlannedSession = {
      schema: 'plan-session/v1',
      date: '2026-04-22',
      session_index: 0,
      kind: 'run',
      summary: 'Intervals 3K×4',
      notes_md: null,
      total_distance_m: 14500,
      total_duration_s: null,
      scheduled_workout_id: null,
      spec: {
        schema: 'run-workout/v1',
        name: 'i',
        date: '2026-04-22',
        note: null,
        blocks: [
          {
            repeat: 1,
            steps: [
              {
                step_kind: 'warmup',
                duration: { kind: 'distance_m', value: 2000 },
                target: { kind: 'hr_bpm', low: 130, high: 150 },
                note: null,
              },
            ],
          },
          {
            repeat: 4,
            steps: [
              {
                step_kind: 'work',
                duration: { kind: 'distance_m', value: 3000 },
                target: { kind: 'pace_s_km', low: 250, high: 245 },
                note: null,
              },
            ],
          },
          {
            repeat: 1,
            steps: [
              {
                step_kind: 'cooldown',
                duration: { kind: 'distance_m', value: 2000 },
                target: { kind: 'hr_bpm', low: 120, high: 145 },
                note: null,
              },
            ],
          },
        ],
      },
    }

    render(
      <PlannedCalendar
        weekDates={WEEK_DATES}
        sessions={[intervalSession]}
        nutrition={[]}
        structuredStatus="fresh"
        canPushRun={true}
        onPush={() => {}}
      />,
    )

    // Pace from the work step shows.
    expect(screen.getByText(/4:05.*4:10/)).toBeInTheDocument()
    // Warmup/cooldown HR (130-150 / 120-145) must NOT bleed through.
    expect(screen.queryByText(/130.*150 bpm/)).not.toBeInTheDocument()
    expect(screen.queryByText(/120.*145 bpm/)).not.toBeInTheDocument()
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
