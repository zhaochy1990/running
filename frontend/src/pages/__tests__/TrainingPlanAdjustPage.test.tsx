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
  type MasterPlanAdjustMessageResponse,
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

async function chooseDirection(direction = '把周跑量降低到 45–50 公里') {
  fireEvent.click(await screen.findByRole('button', { name: direction }))
  fireEvent.click(screen.getByRole('button', { name: '确认调整方向' }))
  return screen.findByText('你希望调整哪个阶段？')
}

async function chooseDirectionAndPhase(
  direction = '把周跑量降低到 45–50 公里',
  phase = '基础期',
) {
  await chooseDirection(direction)
  fireEvent.click(screen.getByRole('button', { name: phase }))
  await waitFor(() => expect(sendMasterPlanAdjustMessage).toHaveBeenCalled())
}

function proposalResponse(): {
  ok: true
  status: number
  data: MasterPlanAdjustMessageResponse
} {
  return {
    ok: true as const,
    status: 200,
    data: {
      stage: 'proposal' as const,
      ai_response: '当前负荷支持小幅降低基础期周量。',
      clarification: null,
      assessment: {
        adjustment_request: '基础期：把周跑量降低到 45–50 公里',
        verdict: 'reasonable' as const,
        rationale: '近期负荷稳定，降低到该区间不会破坏赛季连续性。',
      },
      diff: {
        diff_id: 'diff-1',
        plan_id: 'plan-1',
        ai_explanation: '将基础期周跑量调整到 45–50 公里。',
        created_at: '2026-06-10T00:00:00Z',
        ops: [
          {
            id: 'op-1',
            op: 'replace_weekly_range',
            phase_id: 'phase-1',
            milestone_id: null,
            old_value: { weekly_distance_km_low: 42, weekly_distance_km_high: 54 },
            new_value: { weekly_distance_km_low: 45, weekly_distance_km_high: 50 },
            spec_patch: { weekly_distance_km_low: 45, weekly_distance_km_high: 50 },
            accepted: null,
          },
        ],
      },
    },
  }
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
    vi.mocked(sendMasterPlanAdjustMessage).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        stage: 'assessment',
        ai_response: '已完成数据评估',
        clarification: null,
        assessment: {
          adjustment_request: '基础期：把周跑量降低到 45–50 公里',
          verdict: 'unreasonable',
          rationale: '默认测试评估结果。',
        },
        diff: null,
      },
    })
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

  it('does not load scan data or ask Coach before direction and phase are clear', async () => {
    renderAdjustPage()

    expect(await screen.findByText('这次具体想怎么调整训练计划？')).toBeInTheDocument()
    expect(screen.queryByText('STRIDE 正在查看你的情况')).not.toBeInTheDocument()
    expect(getActivities).not.toHaveBeenCalled()
    expect(getHealth).not.toHaveBeenCalled()
    expect(getHrv).not.toHaveBeenCalled()
    expect(getPMC).not.toHaveBeenCalled()
    expect(getStrideZones).not.toHaveBeenCalled()
    expect(getWeeks).not.toHaveBeenCalled()
    expect(getPlanDays).not.toHaveBeenCalled()
    expect(sendMasterPlanAdjustMessage).not.toHaveBeenCalled()

    await chooseDirection()

    expect(getActivities).not.toHaveBeenCalled()
    expect(getHealth).not.toHaveBeenCalled()
    expect(getPMC).not.toHaveBeenCalled()
    expect(sendMasterPlanAdjustMessage).not.toHaveBeenCalled()
  })

  it('skips the phase question when the adjustment does not target a phase', async () => {
    renderAdjustPage()
    const direction = '把目标比赛延期到 2026-11-08，并顺延训练计划'

    fireEvent.change(await screen.findByLabelText('这次具体想怎么调整训练计划？'), {
      target: { value: direction },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认调整方向' }))

    expect(screen.queryByText('你希望调整哪个阶段？')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(sendMasterPlanAdjustMessage).toHaveBeenCalledWith(
        'plan-1',
        direction,
        [],
      )
    })
    expect(getActivities).toHaveBeenCalledTimes(1)
  })

  it('keeps scan data locked when Coach asks for missing increase details', async () => {
    vi.mocked(sendMasterPlanAdjustMessage).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        stage: 'clarification',
        ai_response: '你想调整哪个阶段的周跑量，以及希望调整到什么区间或调整多少百分比？',
        clarification: '你想调整哪个阶段的周跑量，以及希望调整到什么区间或调整多少百分比？',
        assessment: null,
        diff: null,
      },
    })
    renderAdjustPage()

    fireEvent.change(await screen.findByLabelText('这次具体想怎么调整训练计划？'), {
      target: { value: '我想要加量' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认调整方向' }))

    expect(await screen.findByText('请补充调整细节')).toBeInTheDocument()
    expect(screen.getAllByText(/调整哪个阶段/).length).toBeGreaterThan(0)
    expect(getActivities).not.toHaveBeenCalled()
    expect(getHealth).not.toHaveBeenCalled()
    expect(getPMC).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('请补充调整细节'), {
      target: { value: '专项期增加到 82–96 公里' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认补充信息' }))

    await waitFor(() => {
      expect(sendMasterPlanAdjustMessage).toHaveBeenLastCalledWith(
        'plan-1',
        '我想要加量；专项期增加到 82–96 公里',
        [],
      )
    })
    await waitFor(() => expect(getActivities).toHaveBeenCalledTimes(1))
  })

  it('loads scan data only after the target phase is selected', async () => {
    vi.mocked(getHrv).mockRejectedValueOnce(new Error('hrv unavailable'))

    renderAdjustPage()
    await chooseDirectionAndPhase()

    expect(await screen.findByText('STRIDE 正在查看你的情况')).toBeInTheDocument()
    await waitFor(() => expect(getActivities).toHaveBeenCalledTimes(1))
    expect(getHealth).toHaveBeenCalledTimes(1)
    expect(getPMC).toHaveBeenCalledTimes(1)
    expect(sendMasterPlanAdjustMessage).toHaveBeenCalledWith(
      'plan-1',
      '基础期：把周跑量降低到 45–50 公里',
      [],
    )
    expect(within(screen.getByTestId('scan-row-completion')).getByText('本周完成度')).toBeInTheDocument()
    expect(screen.getAllByText('近 2 周训练量')).toHaveLength(2)
    expect(screen.getAllByText('18.0 km / 14天')).toHaveLength(2)
    expect(screen.getAllByText('静息心率 (RHR)')).toHaveLength(2)
    expect(screen.getAllByText('48 bpm · 基线 47')).toHaveLength(2)
    expect(screen.getByText('VO₂max 估算')).toBeInTheDocument()
    expect(screen.getByText('56.4')).toBeInTheDocument()
    expect(within(screen.getByTestId('scan-row-hrv')).getByText('暂无数据')).toBeInTheDocument()
    expect(screen.getByText('Z2 有氧 5:45-5:05/km')).toBeInTheDocument()
  })

  it('renders the current plan but keeps data evaluation and proposal locked initially', async () => {
    renderAdjustPage()

    expect(await screen.findByText('当前计划')).toBeInTheDocument()
    expect(screen.getByText('目标比赛')).toBeInTheDocument()
    expect(screen.getByText('真实调整马拉松')).toBeInTheDocument()
    expect(screen.getByText(/全马 · 2026 \/ 10 \/ 11/)).toBeInTheDocument()
    expect(screen.getByText(/全程周量曲线 · 23 周/)).toBeInTheDocument()
    expect(screen.getByText(/峰值 66km/)).toBeInTheDocument()
    expect(screen.getByText('阶段划分 · 起止与周数')).toBeInTheDocument()
    expect(screen.queryByText('STRIDE 正在查看你的情况')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新计划' })).not.toBeInTheDocument()
    expect(screen.getByText('澄清完成前不读取训练数据、不生成方案')).toBeInTheDocument()
    expect(screen.queryByText(/从 W0 到西马/)).not.toBeInTheDocument()
    expect(screen.queryByText('西安马拉松')).not.toBeInTheDocument()
    expect(screen.queryByText(/峰值 65km/)).not.toBeInTheDocument()
  })

  it('shows no proposal for an unreasonable adjustment and lets the runner revise', async () => {
    vi.mocked(sendMasterPlanAdjustMessage).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        stage: 'assessment',
        ai_response: '近期负荷不足以支持该增量。',
        clarification: null,
        assessment: {
          adjustment_request: '基础期：把周跑量提高到 55–65 公里',
          verdict: 'unreasonable',
          rationale: '近期稳定周量只有 35 公里，直接提高到该区间会造成负荷跳升。',
        },
        diff: null,
      },
    })

    renderAdjustPage()
    await chooseDirectionAndPhase('把周跑量提高到 55–65 公里')

    expect(await screen.findByText('暂不建议')).toBeInTheDocument()
    expect(screen.getByText(/直接提高到该区间会造成负荷跳升/)).toBeInTheDocument()
    expect(screen.queryByText('后端调整建议')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新计划' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '修改我的想法' }))
    expect(await screen.findByText('这次具体想怎么调整训练计划？')).toBeInTheDocument()
  })

  it('unlocks the typed proposal only after a reasonable assessment', async () => {
    vi.mocked(sendMasterPlanAdjustMessage).mockResolvedValueOnce(proposalResponse())
    renderAdjustPage()
    await chooseDirectionAndPhase()

    expect(await screen.findByText('后端调整建议')).toBeInTheDocument()
    expect(screen.getAllByText('将基础期周跑量调整到 45–50 公里。')).toHaveLength(2)
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(screen.getByRole('button', { name: '新计划' })).toBeInTheDocument()
    expect(screen.getByText('STRIDE 重新规划 · 基于本次反馈 · 未保存')).toBeInTheDocument()
    expect(screen.queryByText('目标比赛 · 不变')).not.toBeInTheDocument()
  })

  it('previews a changed race date from an atomic race proposal', async () => {
    const response = proposalResponse()
    const adjustmentRequest = '把目标比赛延期到 2026-11-08，并顺延训练计划'
    response.data.assessment = {
      adjustment_request: adjustmentRequest,
      verdict: 'reasonable',
      rationale: '官方改期，顺延后仍保留完整减量期。',
    }
    response.data.diff = {
      diff_id: 'diff-race',
      plan_id: 'plan-1',
      ai_explanation: '目标比赛和赛季边界顺延到 2026-11-08。',
      created_at: '2026-06-10T00:00:00Z',
      ops: [{
      id: 'op-race',
      op: 'reschedule_target_race',
      phase_id: null,
      milestone_id: null,
      old_value: { race_date: '2026-10-11' },
      new_value: { race_date: '2026-11-08' },
      spec_patch: {
        race_date: '2026-11-08',
        phase_updates: [{ phase_id: 'phase-2', end_date: '2026-11-08' }],
      },
      accepted: null,
      }],
    }
    vi.mocked(sendMasterPlanAdjustMessage).mockResolvedValueOnce(response)
    renderAdjustPage()

    fireEvent.change(await screen.findByLabelText('这次具体想怎么调整训练计划？'), {
      target: { value: adjustmentRequest },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认调整方向' }))

    expect(await screen.findByText('后端调整建议')).toBeInTheDocument()
    expect(screen.getByText('目标比赛 · 已调整')).toBeInTheDocument()
    expect(screen.getByText(/全马 · 2026 \/ 11 \/ 08/)).toBeInTheDocument()
    expect(screen.getByText(/全程周量曲线 · 27 周/)).toBeInTheDocument()
  })

  it('retries a failed assessment without exposing a local fake preview', async () => {
    vi.mocked(sendMasterPlanAdjustMessage)
      .mockRejectedValueOnce(new Error('service unavailable'))
      .mockResolvedValueOnce(proposalResponse())

    renderAdjustPage()
    await chooseDirectionAndPhase()

    expect(await screen.findByText(/评估请求失败/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新计划' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试评估' }))

    expect(await screen.findByText('后端调整建议')).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(sendMasterPlanAdjustMessage).toHaveBeenCalledTimes(2)
  })

  it('renders returned diff ops selected by default and applies selected op ids', async () => {
    vi.mocked(sendMasterPlanAdjustMessage).mockResolvedValueOnce(proposalResponse())

    renderAdjustPage()
    await chooseDirectionAndPhase()

    expect(await screen.findByText('后端调整建议')).toBeInTheDocument()
    const selectedOps = screen.getAllByRole('checkbox')
    expect(selectedOps).toHaveLength(1)
    selectedOps.forEach((checkbox) => expect(checkbox).toBeChecked())

    fireEvent.click(screen.getByRole('button', { name: '采用这份计划' }))

    await waitFor(() => {
      expect(applyMasterPlanAdjustDiff).toHaveBeenCalledWith(
        'plan-1',
        'diff-1',
        ['op-1'],
        expect.stringContaining('基础期'),
      )
    })
    expect(await screen.findByText('受影响周次')).toBeInTheDocument()
    expect(screen.getByText('2026-06-08_06-14')).toBeInTheDocument()
  })
})
