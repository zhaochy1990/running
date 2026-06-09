import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import {
  applyMasterPlanAdjustDiff,
  getActivities,
  getCurrentMasterPlan,
  getHealth,
  getHrv,
  getMyProfile,
  getPMC,
  getPlanDays,
  getStrideZones,
  getTrainingPlan,
  getWeeks,
  sendMasterPlanAdjustMessage,
  type Activity,
} from '../../api'
import { UserContext } from '../../UserContextValue'
import TrainingPlanAdjustPage from '../TrainingPlanAdjustPage'

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
    getActivities: vi.fn(),
    getCurrentMasterPlan: vi.fn(),
    getHealth: vi.fn(),
    getHrv: vi.fn(),
    getMyProfile: vi.fn(),
    getPMC: vi.fn(),
    getPlanDays: vi.fn(),
    getStrideZones: vi.fn(),
    getTrainingPlan: vi.fn(),
    getWeeks: vi.fn(),
    sendMasterPlanAdjustMessage: vi.fn(),
    applyMasterPlanAdjustDiff: vi.fn(),
  }
})

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    label_id: overrides.label_id ?? 'activity-1',
    name: overrides.name ?? 'Run',
    sport_type: overrides.sport_type ?? 100,
    sport_name: overrides.sport_name ?? 'Run',
    date: overrides.date ?? '2026-06-09T06:00:00+08:00',
    distance_m: overrides.distance_m ?? 8000,
    distance_km: overrides.distance_km ?? 8,
    duration_s: overrides.duration_s ?? 2400,
    duration_fmt: overrides.duration_fmt ?? '00:40:00',
    avg_pace_s_km: overrides.avg_pace_s_km ?? 300,
    pace_fmt: overrides.pace_fmt ?? '5:00/km',
    avg_hr: overrides.avg_hr ?? 145,
    max_hr: overrides.max_hr ?? 170,
    avg_cadence: overrides.avg_cadence ?? 180,
    calories_kcal: overrides.calories_kcal ?? 500,
    training_load: overrides.training_load ?? 120,
    vo2max: overrides.vo2max ?? null,
    train_type: overrides.train_type ?? null,
    ascent_m: overrides.ascent_m ?? null,
    aerobic_effect: overrides.aerobic_effect ?? null,
    anaerobic_effect: overrides.anaerobic_effect ?? null,
    temperature: overrides.temperature ?? null,
    humidity: overrides.humidity ?? null,
    feels_like: overrides.feels_like ?? null,
    wind_speed: overrides.wind_speed ?? null,
    feel_type: overrides.feel_type ?? null,
    sport_note: overrides.sport_note ?? null,
    pauses: overrides.pauses ?? [],
    route_thumb: overrides.route_thumb ?? null,
  }
}

const masterPlan = {
  plan_id: 'plan-1',
  user_id: 'user-1',
  status: 'active',
  goal_id: 'goal-1',
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
      milestone_ids: [],
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
      milestone_ids: [],
    },
  ],
  milestones: [],
  training_principles: ['逐步加量'],
  generated_by: 'gpt-4.1',
  version: 2,
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
  current_phase_id: 'phase-1',
  current_week_number: 6,
  total_weeks: 23,
  next_milestone: null,
}

function renderAdjustPage() {
  return render(
    <UserContext.Provider value={{ user: 'user-1', displayName: 'Runner', refresh: async () => {} }}>
      <MemoryRouter initialEntries={['/plan/adjust']}>
        <Routes>
          <Route path="/plan/adjust" element={<TrainingPlanAdjustPage />} />
          <Route path="/plan" element={<div>Plan route reached</div>} />
        </Routes>
      </MemoryRouter>
    </UserContext.Provider>,
  )
}

async function completeBuildFlow() {
  fireEvent.click(await screen.findByRole('button', { name: '继续加量 / 强化能力' }))
  fireEvent.click(await screen.findByRole('button', { name: '专项能力' }))
  fireEvent.click(await screen.findByRole('button', { name: '4 次跑步' }))
  return screen.findByText('新计划预览')
}

describe('TrainingPlanAdjustPage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getCurrentMasterPlan).mockResolvedValue(masterPlan)
    vi.mocked(getMyProfile).mockResolvedValue({
      id: 'user-1',
      display_name: 'Runner',
      profile: {
        target_race: '真实调整马拉松',
        target_distance: 'FM',
        target_race_date: '2026-10-11',
        target_time: '03:15:00',
      },
      onboarding: { coros_ready: true, profile_ready: true, completed_at: '2026-05-01T00:00:00Z' },
    })
    vi.mocked(getTrainingPlan).mockResolvedValue({
      content: '# Plan\n\nCurrent markdown plan.',
      phases: [
        { name: 'Phase 1：基础期', start: '2026-05-04', end: '2026-06-28' },
      ],
      current_phase: 'Phase 1：基础期',
    })
    vi.mocked(getWeeks).mockResolvedValue({
      weeks: [{
        folder: '2026-06-08_06-14(P1W6)',
        date_from: '2026-06-08',
        date_to: '2026-06-14',
        has_plan: true,
        has_feedback: false,
        has_body_composition: false,
        activity_count: 2,
        total_km: 18,
        total_duration_s: 5400,
        total_duration_fmt: '1:30:00',
      }],
    })
    vi.mocked(getPlanDays).mockResolvedValue({
      days: [
        { date: '2026-06-08', sessions: [], nutrition: null },
        {
          date: '2026-06-09',
          sessions: [{
            schema: 'plan-session/v1',
            id: 1,
            date: '2026-06-09',
            session_index: 0,
            kind: 'run',
            summary: 'Easy 8km',
            spec: null,
            notes_md: null,
            total_distance_m: 8000,
            total_duration_s: 2400,
            scheduled_workout_id: null,
            pushable: true,
          }],
          nutrition: null,
        },
        {
          date: '2026-06-11',
          sessions: [{
            schema: 'plan-session/v1',
            id: 2,
            date: '2026-06-11',
            session_index: 0,
            kind: 'run',
            summary: 'Tempo 10km',
            spec: null,
            notes_md: null,
            total_distance_m: 10000,
            total_duration_s: 3000,
            scheduled_workout_id: null,
            pushable: true,
          }],
          nutrition: null,
        },
      ],
    })
    vi.mocked(getActivities).mockResolvedValue({
      total: 2,
      offset: 0,
      limit: 20,
      activities: [
        makeActivity({ label_id: 'a1', date: '2026-06-09T06:00:00+08:00', distance_km: 8, distance_m: 8000, vo2max: 56.4 }),
        makeActivity({ label_id: 'a2', date: '2026-06-07T06:00:00+08:00', distance_km: 10, distance_m: 10000, sport_note: '右跟腱有点紧' }),
      ],
    })
    vi.mocked(getHealth).mockResolvedValue({
      health: [{
        date: '20260610',
        ati: 30,
        cti: 45,
        rhr: 48,
        distance_m: null,
        duration_s: null,
        training_load_ratio: 0.9,
        training_load_state: 'Optimal',
        fatigue: 42,
        body_battery_high: null,
        body_battery_low: null,
        stress_avg: null,
        sleep_total_s: 25200,
        sleep_deep_s: null,
        sleep_light_s: null,
        sleep_rem_s: null,
        sleep_awake_s: null,
        sleep_score: 84,
        respiration_avg: null,
        spo2_avg: null,
        provider: 'coros',
      }],
      hrv: {
        avg_sleep_hrv: 48,
        hrv_normal_low: 45,
        hrv_normal_high: 62,
        recovery_pct: null,
        trend: [],
        date: '2026-06-10',
      },
      rhr_baseline: 47,
    })
    vi.mocked(getHrv).mockResolvedValue({
      hrv: [],
      summary: {
        date: '2026-06-10',
        last_night_avg: 48,
        weekly_avg: 50,
        status: 'balanced',
        daily_balanced_low: 45,
        daily_balanced_upper: 62,
      },
    })
    vi.mocked(getPMC).mockResolvedValue({
      pmc: [],
      summary: {
        current_cti: null,
        current_ati: null,
        current_tsb: null,
        current_tsb_zone: null,
        current_tsb_zone_label: null,
        current_fatigue: null,
        current_rhr: null,
        ctl_ramp: null,
        date: null,
      },
      stride_summary: {
        date: '2026-06-10',
        current_training_dose: 120,
        current_acute_load: 34,
        current_chronic_load: 39,
        current_form: 5,
        current_load_ratio: 0.87,
        current_readiness_gate: 'green',
        current_readiness_reasons: [],
        chronic_load_ramp: 2,
      },
    })
    vi.mocked(getStrideZones).mockResolvedValue({
      threshold: null,
      pace_zones: [
        { name: 'Z1', label: '恢复', lower_pace: '6:30', upper_pace: '5:45' },
        { name: 'Z2', label: '有氧', lower_pace: '5:45', upper_pace: '5:05' },
      ],
      hr_zones: [
        { name: 'Z2', label: '有氧', lower_bpm: 135, upper_bpm: 150 },
      ],
    })
    vi.mocked(sendMasterPlanAdjustMessage).mockResolvedValue({ ok: true, status: 200, data: { ai_response: '已生成调整建议', diff: null } })
    vi.mocked(applyMasterPlanAdjustDiff).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        plan_id: 'plan-1',
        version: 3,
        updated_at: '2026-06-10T00:00:00Z',
        applied: 2,
        affected_weeks: [{ folder: '2026-06-08_06-14', reason: 'plan_adjusted' }],
      },
    })
  })

  it('loads scan data from existing APIs and keeps neutral rows when one source fails', async () => {
    vi.mocked(getHrv).mockRejectedValueOnce(new Error('hrv unavailable'))

    renderAdjustPage()

    expect(await screen.findByText('STRIDE 正在查看你的情况')).toBeInTheDocument()
    expect(within(screen.getByTestId('scan-row-completion')).getByText('本周完成度')).toBeInTheDocument()
    expect(screen.getByText('近 2 周训练量')).toBeInTheDocument()
    expect(screen.getByText('18.0 km / 14天')).toBeInTheDocument()
    expect(screen.getByText('静息心率 (RHR)')).toBeInTheDocument()
    expect(screen.getByText('48 bpm · 基线 47')).toBeInTheDocument()
    expect(screen.getByText('VO₂max 估算')).toBeInTheDocument()
    expect(screen.getByText('56.4')).toBeInTheDocument()
    expect(within(screen.getByTestId('scan-row-hrv')).getByText('暂无数据')).toBeInTheDocument()
    expect(screen.getByText('Z2 有氧 5:45-5:05/km')).toBeInTheDocument()
  })

  it('renders the plan reference and scan anatomy from API data', async () => {
    renderAdjustPage()

    expect(await screen.findByText('当前计划')).toBeInTheDocument()
    expect(screen.getByText('目标比赛')).toBeInTheDocument()
    expect(screen.getByText('真实调整马拉松')).toBeInTheDocument()
    expect(screen.getByText(/全马 · 2026 \/ 10 \/ 11/)).toBeInTheDocument()
    expect(screen.getByText(/全程周量曲线 · 23 周/)).toBeInTheDocument()
    expect(screen.getByText(/峰值 66km/)).toBeInTheDocument()
    expect(screen.getByText('阶段划分 · 起止与周数')).toBeInTheDocument()
    expect(screen.getByText('STRIDE 正在查看你的情况')).toBeInTheDocument()
    expect(screen.getByText('配速区间')).toBeInTheDocument()
    expect(screen.getByText('心率区间')).toBeInTheDocument()
    expect(screen.getByText('本阶段训练总结')).toBeInTheDocument()
    expect(screen.getByText('STRIDE 初步判断')).toBeInTheDocument()
    expect(screen.queryByText(/从 W0 到西马/)).not.toBeInTheDocument()
    expect(screen.queryByText('西安马拉松')).not.toBeInTheDocument()
    expect(screen.queryByText(/峰值 65km/)).not.toBeInTheDocument()
  })

  it('branches to body protection questions for de-load intent', async () => {
    renderAdjustPage()

    fireEvent.click(await screen.findByRole('button', { name: '减量缓冲一段时间' }))

    expect(await screen.findByText('身体哪里最需要保护？')).toBeInTheDocument()
  })

  it('branches to build-focus questions for build intent', async () => {
    renderAdjustPage()

    fireEvent.click(await screen.findByRole('button', { name: '继续加量 / 强化能力' }))

    expect(await screen.findByText('这次重点想建立什么？')).toBeInTheDocument()
  })

  it('shows a deterministic preview after final answers and toggles current/new plan', async () => {
    renderAdjustPage()

    await completeBuildFlow()
    expect(screen.getByText(/本次调整/)).toBeInTheDocument()
    expect(screen.getByText('专项能力 · 4 次跑步')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '当前计划' }))
    expect(screen.getByText('训练总纲 · v2 · 2026-06-01')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '新计划' }))
    expect(screen.getByText('STRIDE 重新规划 · 基于本次反馈 · 未保存')).toBeInTheDocument()
  })

  it('lets the runner revise answers from the preview step', async () => {
    renderAdjustPage()

    await completeBuildFlow()
    fireEvent.click(screen.getByRole('button', { name: '再调整一下' }))

    expect(await screen.findByText('这次想怎么调整训练计划？')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '继续加量 / 强化能力' })).toBeInTheDocument()
  })

  it('keeps the local preview and retries adjust-chat errors', async () => {
    vi.mocked(sendMasterPlanAdjustMessage)
      .mockRejectedValueOnce(new Error('service unavailable'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          ai_response: '建议保留预览并生成可选差异。',
          diff: {
            diff_id: 'diff-retry',
            plan_id: 'plan-1',
            ai_explanation: '建议保留预览并生成可选差异。',
            created_at: '2026-06-10T00:00:00Z',
            ops: [{
              id: 'op-retry',
              op: 'replace_phase_focus',
              phase_id: 'phase-1',
              milestone_id: null,
              old_value: { focus: '有氧基础与力量耐受' },
              new_value: { focus: '恢复优先' },
              spec_patch: { focus: '恢复优先' },
              accepted: null,
            }],
          },
        },
      })

    renderAdjustPage()
    await completeBuildFlow()

    expect(await screen.findByText(/调整建议请求失败/)).toBeInTheDocument()
    expect(screen.getByText('新计划预览')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试后端建议' }))

    expect(await screen.findByText('后端调整建议')).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(sendMasterPlanAdjustMessage).toHaveBeenCalledTimes(2)
  })

  it('renders returned diff ops selected by default and applies selected op ids', async () => {
    vi.mocked(sendMasterPlanAdjustMessage).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        ai_response: '建议先减量并调低基础期周量。',
        diff: {
          diff_id: 'diff-1',
          plan_id: 'plan-1',
          ai_explanation: '建议先减量并调低基础期周量。',
          created_at: '2026-06-10T00:00:00Z',
          ops: [
            {
              id: 'op-1',
              op: 'replace_weekly_range',
              phase_id: 'phase-1',
              milestone_id: null,
              old_value: { weekly_distance_km_high: 54 },
              new_value: { weekly_distance_km_high: 45 },
              spec_patch: { weekly_distance_km_high: 45 },
              accepted: null,
            },
            {
              id: 'op-2',
              op: 'replace_phase_focus',
              phase_id: 'phase-1',
              milestone_id: null,
              old_value: { focus: '有氧基础与力量耐受' },
              new_value: { focus: '恢复优先' },
              spec_patch: { focus: '恢复优先' },
              accepted: null,
            },
          ],
        },
      },
    })

    renderAdjustPage()
    fireEvent.click(await screen.findByRole('button', { name: '减量缓冲一段时间' }))
    fireEvent.click(await screen.findByRole('button', { name: '跟腱 / 小腿' }))
    fireEvent.click(await screen.findByRole('button', { name: '3 次跑步' }))

    expect(await screen.findByText('后端调整建议')).toBeInTheDocument()
    const selectedOps = screen.getAllByRole('checkbox')
    expect(selectedOps).toHaveLength(2)
    selectedOps.forEach((checkbox) => expect(checkbox).toBeChecked())

    fireEvent.click(screen.getByRole('button', { name: '采用这份计划' }))

    await waitFor(() => {
      expect(applyMasterPlanAdjustDiff).toHaveBeenCalledWith(
        'plan-1',
        'diff-1',
        ['op-1', 'op-2'],
        expect.stringContaining('减量缓冲'),
      )
    })
    expect(await screen.findByText('受影响周次')).toBeInTheDocument()
    expect(screen.getByText('2026-06-08_06-14')).toBeInTheDocument()
  })
})
