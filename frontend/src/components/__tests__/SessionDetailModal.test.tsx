import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import SessionDetailModal from '../SessionDetailModal'
import type {
  PlannedSession,
  NormalizedRunWorkout,
  NormalizedStrengthWorkout,
} from '../../types/plan'

const RUN_SPEC: NormalizedRunWorkout = {
  schema: 'run-workout/v1',
  name: 'easy',
  date: '2026-04-20',
  note: 'Keep it easy',
  blocks: [
    {
      repeat: 1,
      steps: [
        {
          step_kind: 'warmup',
          duration: { kind: 'distance_m', value: 2000 },
          target: { kind: 'hr_bpm', low: 130, high: 150 },
          note: 'Gentle warmup',
        },
        {
          step_kind: 'work',
          duration: { kind: 'distance_m', value: 8000 },
          target: { kind: 'pace_s_km', low: 360, high: 330 },
          note: 'Conversational',
        },
        {
          step_kind: 'cooldown',
          duration: { kind: 'time_s', value: 300 },
          target: { kind: 'open', low: null, high: null },
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
  note: 'Focus on form',
  exercises: [
    {
      canonical_id: 'T1262',
      display_name: '平板支撑',
      sets: 3,
      target_kind: 'time_s',
      target_value: 60,
      rest_seconds: 30,
      note: '臀腰平直',
    },
    {
      canonical_id: 'T1336',
      display_name: '哑铃高脚杯深蹲',
      sets: 3,
      target_kind: 'reps',
      target_value: 12,
      rest_seconds: 45,
      note: null,
    },
  ],
}

const runSession: PlannedSession = {
  schema: 'plan-session/v1',
  date: '2026-04-20',
  session_index: 0,
  kind: 'run',
  summary: 'Easy 10km',
  spec: RUN_SPEC,
  notes_md: 'RPE 3 — keep conversational',
  total_distance_m: 10000,
  total_duration_s: 3600,
  scheduled_workout_id: null,
}

const strengthSession: PlannedSession = {
  schema: 'plan-session/v1',
  date: '2026-04-21',
  session_index: 0,
  kind: 'strength',
  summary: '核心力量 A',
  spec: STRENGTH_SPEC,
  notes_md: null,
  total_distance_m: null,
  total_duration_s: null,
  scheduled_workout_id: 42,
}

const restSession: PlannedSession = {
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
}

describe('SessionDetailModal', () => {
  it('renders run session with workout steps table', () => {
    render(<SessionDetailModal session={runSession} onClose={() => {}} />)

    expect(screen.getByTestId('session-detail-modal')).toBeInTheDocument()
    expect(screen.getByText('Easy 10km')).toBeInTheDocument()
    expect(screen.getByText('2026-04-20')).toBeInTheDocument()
    expect(screen.getByText('跑步')).toBeInTheDocument()

    // Overview metrics
    expect(screen.getByText(/10\.0 km/)).toBeInTheDocument()
    expect(screen.getByText(/60 min/)).toBeInTheDocument()
    // RPE appears in both overview and notes — verify at least one exists
    expect(screen.getAllByText(/RPE 3/).length).toBeGreaterThanOrEqual(1)

    // Run steps table
    const table = screen.getByTestId('run-steps-table')
    expect(table).toBeInTheDocument()
    expect(screen.getByText('热身')).toBeInTheDocument()
    expect(screen.getByText('训练')).toBeInTheDocument()
    expect(screen.getByText('放松')).toBeInTheDocument()
    expect(screen.getByText('Conversational')).toBeInTheDocument()

    // Spec note
    expect(screen.getByText('Keep it easy')).toBeInTheDocument()
  })

  it('renders strength session with exercises table', () => {
    render(<SessionDetailModal session={strengthSession} onClose={() => {}} />)

    expect(screen.getByText('核心力量 A')).toBeInTheDocument()
    expect(screen.getByText('力量')).toBeInTheDocument()

    // Exercises table
    const table = screen.getByTestId('strength-exercises-table')
    expect(table).toBeInTheDocument()
    expect(screen.getByText('平板支撑')).toBeInTheDocument()
    expect(screen.getByText('哑铃高脚杯深蹲')).toBeInTheDocument()
    expect(screen.getByText('臀腰平直')).toBeInTheDocument()

    // Pushed status
    expect(screen.getByText('✓ 已推送')).toBeInTheDocument()

    // Spec note
    expect(screen.getByText('Focus on form')).toBeInTheDocument()
  })

  it('renders rest session with rest message', () => {
    render(<SessionDetailModal session={restSession} onClose={() => {}} />)

    expect(screen.getByText('完全休息')).toBeInTheDocument()
    expect(screen.getByText('休息日 — 充分恢复')).toBeInTheDocument()
  })

  it('renders notes section when notes_md is present', () => {
    render(<SessionDetailModal session={runSession} onClose={() => {}} />)

    // "备注" appears as both a table header and the notes section label
    expect(screen.getAllByText('备注').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/RPE 3 — keep conversational/)).toBeInTheDocument()
  })

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn()
    render(<SessionDetailModal session={runSession} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('session-detail-modal'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onClose when modal content is clicked', () => {
    const onClose = vi.fn()
    render(<SessionDetailModal session={runSession} onClose={onClose} />)

    // Click on the summary text inside the modal content
    fireEvent.click(screen.getByText('Easy 10km'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn()
    render(<SessionDetailModal session={runSession} onClose={onClose} />)

    fireEvent.click(screen.getByLabelText('关闭'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when Escape key is pressed', () => {
    const onClose = vi.fn()
    render(<SessionDetailModal session={runSession} onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('has correct accessibility attributes', () => {
    render(<SessionDetailModal session={runSession} onClose={() => {}} />)

    const modal = screen.getByTestId('session-detail-modal')
    expect(modal).toHaveAttribute('role', 'dialog')
    expect(modal).toHaveAttribute('aria-modal', 'true')
    expect(modal).toHaveAttribute('aria-labelledby', 'session-detail-title')
  })
})
