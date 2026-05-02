import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import WeekLayout from '../WeekLayout'
import type { WeekDetail, WeekSummary, PlanDaysResponse } from '../../api'

// Hoisted mocks for the api module — each test composes the responses it
// needs. Keep mock signatures narrow (we only mock the ones WeekLayout uses
// in the calendar tab path).
const mocks = vi.hoisted(() => ({
  getWeeks: vi.fn(),
  getWeek: vi.fn(),
  getPlanDays: vi.fn(),
  reparsePlan: vi.fn(),
  pushPlannedSession: vi.fn(),
  updateWeeklyFeedback: vi.fn(),
}))

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api')
  return {
    ...actual,
    getWeeks: mocks.getWeeks,
    getWeek: mocks.getWeek,
    getPlanDays: mocks.getPlanDays,
    reparsePlan: mocks.reparsePlan,
    pushPlannedSession: mocks.pushPlannedSession,
    updateWeeklyFeedback: mocks.updateWeeklyFeedback,
  }
})

vi.mock('../../UserContextValue', () => ({
  useUser: () => ({ user: 'zhaochaoyi' }),
}))

const FOLDER = '2026-04-20_04-26(W0)'

const weeks: WeekSummary[] = [
  {
    folder: FOLDER,
    date_from: '2026-04-20',
    date_to: '2026-04-26',
    has_plan: true,
    has_feedback: false,
    has_inbody: false,
    plan_title: 'Week 0',
    activity_count: 3,
    total_km: 35,
    total_duration_s: 12600,
    total_duration_fmt: '3:30:00',
  },
]

function buildWeekDetail(structuredStatus: string | null): WeekDetail & {
  structured?: { structured_status: string | null }
} {
  return {
    folder: FOLDER,
    date_from: '2026-04-20',
    date_to: '2026-04-26',
    plan: '# Week 0\n\nEasy week.',
    feedback: undefined,
    feedback_source: 'none',
    feedback_updated_at: null,
    feedback_generated_by: null,
    activities: [],
    total_km: 35,
    total_duration_s: 12600,
    total_duration_fmt: '3:30:00',
    activity_count: 3,
    structured: structuredStatus !== null ? { structured_status: structuredStatus } : undefined,
  }
}

const planDaysFresh: PlanDaysResponse = {
  days: [
    {
      date: '2026-04-20',
      sessions: [
        {
          schema: 'plan-session/v1',
          id: 1,
          date: '2026-04-20',
          session_index: 0,
          kind: 'run',
          summary: 'Easy 10km',
          spec: {
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
          },
          notes_md: null,
          total_distance_m: 10000,
          total_duration_s: 3600,
          scheduled_workout_id: null,
          pushable: true,
        },
      ],
      nutrition: null,
    },
    { date: '2026-04-21', sessions: [], nutrition: null },
    { date: '2026-04-22', sessions: [], nutrition: null },
    { date: '2026-04-23', sessions: [], nutrition: null },
    { date: '2026-04-24', sessions: [], nutrition: null },
    { date: '2026-04-25', sessions: [], nutrition: null },
    { date: '2026-04-26', sessions: [], nutrition: null },
  ],
}

beforeEach(() => {
  mocks.getWeeks.mockResolvedValue({ weeks })
  mocks.getPlanDays.mockResolvedValue(planDaysFresh)
})

afterEach(() => {
  vi.clearAllMocks()
})

function renderAt(path = `/week/${FOLDER}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/week/:folder" element={<WeekLayout />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('WeekLayout — calendar tab', () => {
  it('renders 7 day-cards when status=fresh', async () => {
    mocks.getWeek.mockResolvedValue(buildWeekDetail('fresh'))

    renderAt()
    await waitFor(() => expect(screen.getByText('训练计划')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '日历' }))

    await waitFor(() => {
      expect(screen.getAllByTestId('day-card')).toHaveLength(7)
    })
    expect(screen.queryByTestId('reparse-banner')).not.toBeInTheDocument()
  })

  it('shows reparse banner when status=parse_failed and triggers reparsePlan', async () => {
    mocks.getWeek.mockResolvedValue(buildWeekDetail('parse_failed'))
    mocks.reparsePlan.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true, folder: FOLDER, structured_status: 'fresh', parse_error: null },
    })

    renderAt()
    await waitFor(() => expect(screen.getByText('训练计划')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '日历' }))

    await waitFor(() => expect(screen.getByTestId('reparse-banner')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '重新解析' }))

    await waitFor(() => {
      expect(mocks.reparsePlan).toHaveBeenCalledWith('zhaochaoyi', FOLDER)
    })
  })

  it('shows backfill banner when status=backfilled', async () => {
    mocks.getWeek.mockResolvedValue(buildWeekDetail('backfilled'))

    renderAt()
    await waitFor(() => expect(screen.getByText('训练计划')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '日历' }))

    await waitFor(() => expect(screen.getByTestId('reparse-banner')).toBeInTheDocument())
    expect(screen.getByTestId('backfill-banner')).toBeInTheDocument()
  })
})
