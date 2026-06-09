import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { getCurrentMasterPlan, getMyProfile, getTrainingPlan } from '../../api'
import { UserContext } from '../../UserContextValue'
import TrainingPlanPage from '../TrainingPlanPage'

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api')
  return {
    ...actual,
    getCurrentMasterPlan: vi.fn(),
    getMyProfile: vi.fn(),
    getTrainingPlan: vi.fn(),
  }
})

const masterPlan = {
  plan_id: 'plan-real',
  user_id: 'user-1',
  status: 'active',
  goal_id: 'goal-real',
  start_date: '2026-08-03',
  end_date: '2026-12-20',
  phases: [
    {
      id: 'phase-real-1',
      name: '真实基础期',
      start_date: '2026-08-03',
      end_date: '2026-09-27',
      focus: '真实有氧重点与稳定跑量',
      weekly_distance_km_low: 31,
      weekly_distance_km_high: 47,
      key_session_types: ['真实长距离', '真实力量'],
      milestone_ids: ['milestone-real-1'],
    },
    {
      id: 'phase-real-2',
      name: '真实专项期',
      start_date: '2026-09-28',
      end_date: '2026-12-20',
      focus: '真实比赛配速能力',
      weekly_distance_km_low: 45,
      weekly_distance_km_high: 59,
      key_session_types: ['真实阈值跑'],
      milestone_ids: [],
    },
  ],
  milestones: [{
    id: 'milestone-real-1',
    type: 'long_run',
    date: '2026-09-20',
    phase_id: 'phase-real-1',
    target: '真实 30K 检查',
    completed_actual: null,
  }],
  training_principles: ['真实原则：先恢复再加量'],
  generated_by: 'gpt-real-model',
  version: 7,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-10T00:00:00Z',
  current_phase_id: 'phase-real-1',
  current_week_number: 2,
  total_weeks: 20,
  next_milestone: {
    id: 'milestone-real-1',
    date: '2026-09-20',
    target: '真实 30K 检查',
    days_until: 41,
  },
}

function renderPlanPage() {
  return render(
    <UserContext.Provider value={{ user: 'user-1', displayName: 'Runner', refresh: async () => {} }}>
      <MemoryRouter initialEntries={['/plan']}>
        <Routes>
          <Route path="/plan" element={<TrainingPlanPage />} />
          <Route path="/plan/adjust" element={<div>Adjust route reached</div>} />
        </Routes>
      </MemoryRouter>
    </UserContext.Provider>,
  )
}

describe('TrainingPlanPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCurrentMasterPlan).mockResolvedValue(masterPlan)
    vi.mocked(getTrainingPlan).mockResolvedValue({
      content: '# Plan\n\nCurrent season.',
      phases: [
        { name: 'Phase 1：基础期', start: '2026-05-04', end: '2026-06-28' },
        { name: 'Phase 2：专项期', start: '2026-06-29', end: '2026-08-23' },
      ],
      current_phase: 'Phase 1：基础期',
    })
    vi.mocked(getMyProfile).mockResolvedValue({
      id: 'user-1',
      display_name: 'Runner',
      profile: {
        target_race: '真实测试马拉松',
        target_distance: 'FM',
        target_race_date: '2026-12-20',
        target_time: '03:10:00',
      },
      onboarding: { coros_ready: true, profile_ready: true, completed_at: '2026-05-01T00:00:00Z' },
    })
  })

  it('navigates from the plan page primary action to /plan/adjust', async () => {
    renderPlanPage()

    fireEvent.click(await screen.findByRole('button', { name: '调整 / 重新生成计划' }))

    expect(screen.getByText('Adjust route reached')).toBeInTheDocument()
  })

  it('renders the plan overview with real API data instead of design-spec sample values', async () => {
    renderPlanPage()

    expect(await screen.findByRole('heading', { name: /真实测试马拉松/ })).toBeInTheDocument()
    expect(screen.getByText(/gpt-real-model/)).toBeInTheDocument()
    expect(screen.getByText(/v7/)).toBeInTheDocument()
    expect(await screen.findByText('20 周周量曲线')).toBeInTheDocument()
    expect(screen.getByText(/峰值 59 km/)).toBeInTheDocument()
    expect(screen.getByText(/终点 12\/20/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '总览 · 20 周' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /训练周列表/ })).toBeInTheDocument()
    expect(screen.getAllByText(/真实基础期/).length).toBeGreaterThan(0)
    expect(screen.getByText(/真实有氧重点与稳定跑量/)).toBeInTheDocument()
    expect(screen.getAllByText('真实长距离').length).toBeGreaterThan(0)
    expect(screen.getAllByText('真实 30K 检查').length).toBeGreaterThan(0)
    expect(screen.getAllByText('真实原则：先恢复再加量').length).toBeGreaterThan(0)
    expect(screen.queryByText(/claude-3\.7-sonnet/)).not.toBeInTheDocument()
    expect(screen.queryByText(/从 W0 到西马/)).not.toBeInTheDocument()
    expect(screen.queryByText(/周里程从 35 km 稳步推到 50 km/)).not.toBeInTheDocument()
    expect(screen.queryByText(/VO₂max 56\.4/)).not.toBeInTheDocument()
  })
})
