import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import {
  getCurrentMasterPlan,
  getDraftMasterPlan,
  getMyProfile,
  getTrainingGoal,
  getTrainingPlan,
  type MasterPlan,
} from '../../api'
import { UserContext } from '../../UserContextValue'
import TrainingPlanPage from '../TrainingPlanPage'

vi.mock('../../lib/shanghai', async () => {
  const actual = await vi.importActual<typeof import('../../lib/shanghai')>('../../lib/shanghai')
  return {
    ...actual,
    shanghaiToday: () => '2026-06-10',
  }
})

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api')
  return {
    ...actual,
    getCurrentMasterPlan: vi.fn(),
    getDraftMasterPlan: vi.fn(),
    getTrainingPlan: vi.fn(),
    getTrainingGoal: vi.fn(),
    getMyProfile: vi.fn(),
  }
})

const masterPlan: MasterPlan = {
  plan_id: 'plan-1',
  user_id: 'user-1',
  status: 'active',
  start_date: '2026-05-04',
  end_date: '2026-10-11',
  phases: [
    {
      id: 'phase-1',
      name: '基础期',
      start_date: '2026-05-04',
      end_date: '2026-06-28',
      focus: '有氧基础与力量耐受',
      weekly_distance_km_low: 42,
      weekly_distance_km_high: 54,
      key_session_types: ['有氧', '长距离'],
      milestone_ids: ['m1'],
      phase_type: 'base',
      rhythm: '每周 4 跑，长跑稳定推进。',
      key_workouts: '周末长跑和一次有氧耐力课。',
      monitoring_triggers: ['RHR 连续两天升高时下调强度'],
      coach_note: '稳住基础，后面才有速度。',
      is_completed: true,
      summary: {
        total_distance_km: 320,
        run_count: 36,
        weekly_avg_km: 40,
        avg_pace_s_km: 315,
        avg_pace_fmt: '5:15',
        avg_hr: 145,
        hr_zone_distribution: [{ zone_index: 2, minutes: 900, percent: 56.7 }],
      },
    },
    {
      id: 'phase-2',
      name: '专项期',
      start_date: '2026-06-29',
      end_date: '2026-08-23',
      focus: '马拉松配速与阈值能力',
      weekly_distance_km_low: 52,
      weekly_distance_km_high: 66,
      key_session_types: ['阈值', '马拉松配速'],
      milestone_ids: ['m2'],
      phase_type: 'build',
      rhythm: '每周 5 跑，质量课之间保留恢复。',
      key_workouts: '阈值跑与马拉松配速长课交替。',
      monitoring_triggers: ['睡眠不足时质量课顺延'],
      coach_note: '不要强行补课，先保证关键课质量。',
    },
  ],
  milestones: [
    {
      id: 'm1',
      type: '长距离',
      date: '2026-06-28',
      phase_id: 'phase-1',
      target: '完成基础期出口长跑',
      completed_actual: '已完成 26km 长跑',
    },
    {
      id: 'm2',
      type: '测试跑',
      date: '2026-07-19',
      phase_id: 'phase-2',
      target: '10K 测试跑验证阈值能力',
      completed_actual: null,
    },
  ],
  training_principles: ['逐步加量', '每 4 周保留恢复周'],
  training_load_projection: {
    status: 'available',
    unavailable_reason: null,
    calculated_at: '2026-07-15T08:30:00Z',
  },
  weeks: [
    {
      week_index: 1,
      week_start: '2026-05-04',
      week_end: '2026-05-10',
      phase_id: 'phase-1',
      target_weekly_km_low: null,
      target_weekly_km_high: null,
      target_training_dose_low: 180,
      target_training_dose_high: 210,
      planned_distance_km: null,
      is_completed: true,
      actual_distance_km: 46.5,
      actual_avg_pace_s_km: 315,
      actual_avg_pace_fmt: '5:15',
      actual_avg_hr: 140,
      actual_run_count: 4,
      actual_duration_s: 14648,
      key_sessions: [],
      is_recovery_week: false,
      is_taper_week: false,
    },
    {
      week_index: 4,
      week_start: '2026-05-25',
      week_end: '2026-05-31',
      phase_id: 'phase-1',
      target_weekly_km_low: 48,
      target_weekly_km_high: 54,
      target_training_dose_low: 240,
      target_training_dose_high: 275,
      planned_distance_km: 54,
      is_completed: true,
      actual_distance_km: 68,
      actual_avg_pace_s_km: 312,
      actual_avg_pace_fmt: '5:12',
      actual_avg_hr: 142,
      actual_run_count: 5,
      actual_duration_s: 14227,
      key_sessions: [{ type: 'long_run', distance_km: 20, duration_min: null }],
      is_recovery_week: false,
      is_taper_week: false,
    },
    {
      week_index: 6,
      week_start: '2026-06-08',
      week_end: '2026-06-14',
      phase_id: 'phase-1',
      target_weekly_km_low: 78,
      target_weekly_km_high: 88,
      target_training_dose_low: 390,
      target_training_dose_high: 440,
      planned_distance_km: 88,
      is_completed: false,
      actual_distance_km: 12.4,
      actual_avg_pace_s_km: 300,
      actual_avg_pace_fmt: '5:00',
      actual_avg_hr: 145,
      actual_run_count: 1,
      actual_duration_s: 3720,
      key_sessions: [{ type: 'tempo', distance_km: 12, duration_min: null }],
      is_recovery_week: false,
      is_taper_week: false,
    },
    {
      week_index: 9,
      week_start: '2026-06-29',
      phase_id: 'phase-2',
      target_weekly_km_low: 110,
      target_weekly_km_high: 120,
      target_training_dose_low: 520,
      target_training_dose_high: 570,
      key_sessions: [{ type: 'threshold', distance_km: 12, duration_min: null }],
      is_recovery_week: false,
      is_taper_week: false,
    },
    {
      week_index: 10,
      week_start: '2026-07-06',
      phase_id: 'phase-2',
      target_weekly_km_low: 118,
      target_weekly_km_high: 128,
      target_training_dose_low: 560,
      target_training_dose_high: 610,
      key_sessions: [{ type: 'long_run', distance_km: 22, duration_min: null }],
      is_recovery_week: false,
      is_taper_week: false,
    },
    {
      week_index: 11,
      week_start: '2026-07-13',
      phase_id: 'phase-2',
      target_weekly_km_low: 128,
      target_weekly_km_high: 138,
      target_training_dose_low: 610,
      target_training_dose_high: 665,
      key_sessions: [{ type: 'interval', distance_km: 10, duration_min: null }],
      is_recovery_week: false,
      is_taper_week: false,
    },
    {
      week_index: 12,
      week_start: '2026-07-20',
      phase_id: 'phase-2',
      target_weekly_km_low: 94,
      target_weekly_km_high: 104,
      target_training_dose_low: 440,
      target_training_dose_high: 490,
      key_sessions: [{ type: 'long_run', distance_km: 18, duration_min: null }],
      is_recovery_week: true,
      is_taper_week: false,
    },
  ],
  generated_by: 'gpt-4.1',
  version: 2,
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
  current_phase_id: 'phase-1',
  current_week_number: 6,
  total_weeks: 23,
  next_milestone: {
    id: 'm2',
    date: '2026-07-19',
    target: '10K 测试跑验证阈值能力',
    days_until: 39,
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
    vi.resetAllMocks()
    vi.mocked(getCurrentMasterPlan).mockResolvedValue(masterPlan)
    vi.mocked(getDraftMasterPlan).mockResolvedValue(null)
    vi.mocked(getTrainingPlan).mockResolvedValue({
      content: '# Legacy Plan',
      phases: [],
      current_phase: null,
    })
    vi.mocked(getTrainingGoal).mockResolvedValue({
      type: 'race',
      race_distance: 'FM',
      race_name: '真实目标马拉松',
      race_date: '2026-10-11',
      target_finish_time: '03:15:00',
      weekly_training_days: 5,
    })
    vi.mocked(getMyProfile).mockResolvedValue({
      id: 'user-1',
      display_name: 'Runner',
      profile: {},
      onboarding: { coros_ready: true, profile_ready: true, completed_at: '2026-05-01T00:00:00Z' },
    })
  })

  it('renders the current master plan view from live API data', async () => {
    renderPlanPage()

    expect(await screen.findByRole('heading', { name: '真实目标马拉松' })).toBeInTheDocument()
    expect(screen.getByText(/从 2026\/05\/04 到 2026\/10\/11，共 23 周/)).toBeInTheDocument()
    expect(screen.getByText('周跑量（KM/周）')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '负荷' })).toBeEnabled()
    expect(screen.getAllByText('W06').length).toBeGreaterThan(0)
    expect(screen.getByText('已完成周实际跑量')).toBeInTheDocument()
    expect(screen.getByText('计划跑量标记')).toBeInTheDocument()
    expect(screen.getAllByText('计划跑量')[0]).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'W01 实际 46.5 km · 计划 -- · 基础期' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'W01 估算 42 km · 基础期' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'W04 实际 68 km · 计划 54 km · 基础期' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'W04 计划 54 km · 基础期' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'W06 实际 12.4 km · 计划 88 km · 基础期' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'W06 计划 88 km · 基础期' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'W12 计划 104 km · 专项期 · 调整周' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'W12 估算 66 km · 专项期' })).not.toBeInTheDocument()
    expect(screen.getByText('68 km')).toBeInTheDocument()
    expect(screen.getByText('5:12/km')).toBeInTheDocument()
    expect(screen.getByText('142 bpm')).toBeInTheDocument()
    expect(screen.getByText(/目标赛事：全马 · 2026\/10\/11/)).toBeInTheDocument()
    expect(screen.getByText('2026/10/11 · 全马')).toBeInTheDocument()
    expect(screen.getByText('03:15:00')).toBeInTheDocument()
    expect(screen.getAllByText('10K 测试跑验证阈值能力')[0]).toBeInTheDocument()
    expect(screen.getByText('RHR 连续两天升高时下调强度')).toBeInTheDocument()
    expect(screen.getByText('已完成 26km 长跑')).toBeInTheDocument()
    expect(screen.getByText('逐步加量')).toBeInTheDocument()
    expect(screen.queryByText('2026 西安马拉松')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '负荷' }))
    expect(screen.getByText('预计周负荷（STRIDE DOSE）')).toBeInTheDocument()
    expect(screen.getByText('STRIDE dose 是根据计划跑量与关键课估算的每周负荷区间。')).toBeInTheDocument()
    expect(screen.getAllByText('计划负荷')[0]).toBeInTheDocument()
    expect(screen.getAllByText('390-440 dose')[0]).toBeInTheDocument()
  })

  it('keeps mileage usable and disables load for a legacy plan', async () => {
    vi.mocked(getCurrentMasterPlan).mockResolvedValueOnce({
      ...masterPlan,
      training_load_projection: null,
      weeks: (masterPlan.weeks ?? []).map((week) => ({
        ...week,
        target_training_dose_low: null,
        target_training_dose_high: null,
      })),
    })

    renderPlanPage()

    expect(await screen.findByText('周跑量（KM/周）')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '负荷' })).toBeDisabled()
    expect(screen.getByText('该计划尚无可用的周负荷数据')).toBeInTheDocument()
  })

  it('falls back to profile target fields when the training goal is unavailable', async () => {
    vi.mocked(getTrainingGoal).mockResolvedValueOnce(null)
    vi.mocked(getMyProfile).mockResolvedValueOnce({
      id: 'user-1',
      display_name: 'Runner',
      profile: {
        target_race: '个人资料马拉松',
        target_distance: 'HM',
        target_race_date: '2026-09-20',
        target_time: '01:29:30',
      },
      onboarding: { coros_ready: true, profile_ready: true, completed_at: '2026-05-01T00:00:00Z' },
    })

    renderPlanPage()

    expect(await screen.findByRole('heading', { name: '个人资料马拉松' })).toBeInTheDocument()
    expect(screen.getByText(/目标赛事：半马 · 2026\/09\/20/)).toBeInTheDocument()
    expect(screen.getByText('2026/09/20 · 半马')).toBeInTheDocument()
    expect(screen.getByText('01:29:30')).toBeInTheDocument()
  })

  it('renders a draft master plan in review mode instead of auto-confirming it', async () => {
    vi.mocked(getCurrentMasterPlan).mockResolvedValueOnce(null)
    vi.mocked(getDraftMasterPlan).mockResolvedValueOnce({
      ...masterPlan,
      status: 'draft',
      plan_id: 'draft-1',
    })
    vi.mocked(getTrainingPlan).mockResolvedValueOnce({
      content: null,
      phases: [],
      current_phase: null,
    })

    renderPlanPage()

    expect(await screen.findByRole('heading', { name: '审阅你的赛季训练计划' })).toBeInTheDocument()
    expect(screen.getByText('和 Coach 审阅计划')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /启用计划/ })[0]).toBeInTheDocument()
    expect(screen.queryByText('调整计划')).not.toBeInTheDocument()
  })
})
