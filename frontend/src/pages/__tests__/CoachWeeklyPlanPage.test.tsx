import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoachWeeklyPlanState } from '../../hooks/useCoachWeeklyPlan'

const weeklyPlanState = vi.hoisted(() => ({ current: null as CoachWeeklyPlanState | null }))

vi.mock('../../hooks/useCoachWeeklyPlan', () => ({
  useCoachWeeklyPlan: () => weeklyPlanState.current,
}))

import CoachWeeklyPlanPage from '../CoachWeeklyPlanPage'

const emptyState: CoachWeeklyPlanState = {
  folder: null,
  week: null,
  weeks: [],
  planDays: [],
  strength: null,
  structuredStatus: 'none',
  canPushRun: true,
  canPushStrength: true,
  loading: false,
  error: null,
  saveFeedback: vi.fn(),
  pushSession: vi.fn(),
  refresh: vi.fn(),
}

describe('CoachWeeklyPlanPage', () => {
  beforeEach(() => {
    weeklyPlanState.current = emptyState
  })

  it('prompts users to generate a plan when no training week exists', () => {
    render(<CoachWeeklyPlanPage />)

    expect(screen.getByRole('heading', { name: '使用 Coach Agent 生成本周计划' })).toBeInTheDocument()
    expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
  })

  it('prompts users to generate a plan when the selected week has no plan', () => {
    weeklyPlanState.current = {
      ...emptyState,
      week: {
        folder: '2026-07-13_07-19',
        date_from: '2026-07-13',
        date_to: '2026-07-19',
        activities: [],
        activity_count: 0,
        total_km: 0,
        total_duration_s: 0,
        total_duration_fmt: '0m',
      },
    }

    render(<CoachWeeklyPlanPage />)

    expect(screen.getByRole('heading', { name: '使用 Coach Agent 生成本周计划' })).toBeInTheDocument()
  })

  it('renders the four design tabs and structured weekly overview', () => {
    weeklyPlanState.current = {
      ...emptyState,
      weeks: [{ folder: '2026-07-13_07-19', date_from: '2026-07-13', date_to: '2026-07-19', has_plan: true, has_feedback: false, has_body_composition: false, plan_title: '基础期 W1', activity_count: 1, total_km: 8, total_duration_s: 3000, total_duration_fmt: '50m' }],
      week: {
        folder: '2026-07-13_07-19', date_from: '2026-07-13', date_to: '2026-07-19', plan: '# plan', activities: [], activity_count: 0, total_km: 0, total_duration_s: 0, total_duration_fmt: '0m',
      },
      planDays: [{ date: '2026-07-13', nutrition: { schema: 'plan-nutrition/v1', date: '2026-07-13', kcal_target: null, carbs_g: null, protein_g: 130, fat_g: null, water_ml: null, meals: [], notes_md: '训练后补充蛋白质' }, sessions: [{ id: 1, pushable: false, schema: 'plan-session/v1', date: '2026-07-13', session_index: 0, kind: 'run', summary: '轻松跑', spec: null, notes_md: '保持 Z2', total_distance_m: 8000, total_duration_s: 3000, scheduled_workout_id: null }] }],
      strength: {
        folder: '2026-07-13_07-19',
        sessions: [{
          date: '2026-07-13',
          session_index: 1,
          summary: '髋稳定与核心',
          notes_md: '保持动作控制',
          exercises: [{ canonical_id: 'side-plank', display_name: 'Side plank', sets: 3, target_kind: 'time_s', target_value: 30, rest_seconds: 30, note: '骨盆稳定', code: null, image_url: null, name_zh: '侧桥', key_points: [], muscle_focus: [], common_mistakes: [] }],
        }],
      },
      structuredStatus: 'fresh',
    }

    render(<CoachWeeklyPlanPage />)

    expect(screen.getByRole('heading', { name: '本周课表' })).toBeInTheDocument()
    expect(screen.getAllByText('计划跑量')).not.toHaveLength(0)
    expect(screen.getByText('低强度 Z1+Z2')).toBeInTheDocument()
    expect(screen.getByText('高强度 Z4+Z5')).toBeInTheDocument()
    expect(screen.getByText('训练课')).toBeInTheDocument()
    expect(screen.getByText('跑步课')).toBeInTheDocument()
    expect(screen.queryByText('Sessions')).not.toBeInTheDocument()
    expect(screen.queryByText('Runs')).not.toBeInTheDocument()
    expect(screen.getAllByText('蛋白质目标 130 g')).toHaveLength(2)
    expect(screen.queryByText(/P130/)).not.toBeInTheDocument()
    expect(screen.getByText('实际跑量')).toBeInTheDocument()
    expect(screen.getByText('完成度')).toBeInTheDocument()
    expect(screen.queryByText('Planned volume')).not.toBeInTheDocument()
    expect(screen.queryByText('Completion')).not.toBeInTheDocument()
    expect(screen.getByText('力量训练 0 次 · 00:00:00')).toBeInTheDocument()
    expect(screen.getAllByText('本周训练重点')).toHaveLength(1)
    expect(screen.queryByText(/按计划完成关键跑步课/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^多 session ·/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(4)
    expect(screen.getByRole('tab', { name: '本周训练课表' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('轻松跑')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /^本周力量训练/ }))
    expect(screen.getByRole('heading', { name: '1 次力量维护，服务本周跑步计划' })).toBeInTheDocument()
    expect(screen.getByText('侧桥')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /^本周训练记录/ }))
    expect(screen.getByRole('heading', { name: '本周训练记录' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '本周反馈' }))
    expect(screen.getByRole('heading', { name: '围绕本周关键课记录体感' })).toBeInTheDocument()
  })
})
