import { describe, expect, it } from 'vitest'
import type { PlanDay, PlannedSessionRow } from '../../../api'
import type { PlannedNutrition } from '../../../types/plan'
import { projectCurrentWeekPlan } from '../currentWeekProjection'

function runSession(overrides: Partial<PlannedSessionRow> = {}): PlannedSessionRow {
  return {
    schema: 'plan-session/v1',
    date: '2026-07-27',
    session_index: 0,
    kind: 'run',
    summary: '轻松跑 8 km',
    spec: null,
    notes_md: null,
    total_distance_m: 8000,
    total_duration_s: null,
    scheduled_workout_id: null,
    id: 1,
    pushable: false,
    ...overrides,
  }
}

function strengthSession(): PlannedSessionRow {
  return runSession({
    date: '2026-07-28',
    kind: 'strength',
    summary: '下肢力量 A',
    total_distance_m: null,
    spec: {
      schema: 'strength-workout/v1',
      name: '下肢力量 A',
      date: '2026-07-28',
      note: '控制离心',
      exercises: [
        {
          canonical_id: 'goblet_squat',
          display_name: '高脚杯深蹲',
          sets: 3,
          target_kind: 'reps',
          target_value: 12,
          rest_seconds: 90,
          note: null,
        },
        {
          canonical_id: 'plank',
          display_name: '平板支撑',
          sets: 3,
          target_kind: 'time_s',
          target_value: 45,
          rest_seconds: 0,
          note: null,
        },
      ],
    },
  })
}

function nutrition(): PlannedNutrition {
  return {
    schema: 'plan-nutrition/v1',
    date: '2026-07-27',
    kcal_target: 2400,
    carbs_g: 300,
    protein_g: 140,
    fat_g: 70,
    water_ml: 2500,
    meals: [
      {
        name: '早餐',
        time_hint: '07:30',
        kcal: 600,
        carbs_g: 80,
        protein_g: 30,
        fat_g: 15,
        items_md: '燕麦 + 鸡蛋',
      },
    ],
    notes_md: '训练后补碳',
  }
}

describe('projectCurrentWeekPlan', () => {
  it('emits one calendar row per session and a rest row for empty days', () => {
    const days: PlanDay[] = [
      { date: '2026-07-27', sessions: [runSession()], nutrition: null },
      { date: '2026-07-28', sessions: [], nutrition: null },
    ]
    const projection = projectCurrentWeekPlan(days)
    expect(projection.days).toEqual([
      { label: '2026-07-27', detail: '轻松跑 8 km' },
      { label: '2026-07-28', detail: '休息 · 无训练安排' },
    ])
  })

  it('projects strength specs into the standalone strength section', () => {
    const days: PlanDay[] = [
      { date: '2026-07-28', sessions: [strengthSession()], nutrition: null },
    ]
    const projection = projectCurrentWeekPlan(days)
    expect(projection.strength).toHaveLength(1)
    const day = projection.strength[0]
    expect(day.label).toBe('2026-07-28')
    expect(day.title).toBe('下肢力量 A')
    expect(day.note).toBe('控制离心')
    expect(day.exercises[0]).toEqual({
      name: '高脚杯深蹲',
      sets: 3,
      target: '12 次',
      rest: '休息 90 秒',
      note: null,
    })
    // time-based target renders as seconds; zero rest is omitted.
    expect(day.exercises[1]).toEqual({
      name: '平板支撑',
      sets: 3,
      target: '45 秒',
      rest: null,
      note: null,
    })
  })

  it('projects nutrition days and meals', () => {
    const days: PlanDay[] = [
      { date: '2026-07-27', sessions: [runSession()], nutrition: nutrition() },
    ]
    const projection = projectCurrentWeekPlan(days)
    expect(projection.nutrition).toHaveLength(1)
    const day = projection.nutrition[0]
    expect(day.label).toBe('2026-07-27')
    expect(day.kcalTarget).toBe(2400)
    expect(day.proteinG).toBe(140)
    expect(day.waterMl).toBe(2500)
    expect(day.meals[0]).toEqual({
      name: '早餐',
      timeHint: '07:30',
      kcal: 600,
      carbsG: 80,
      proteinG: 30,
      fatG: 15,
      itemsMd: '燕麦 + 鸡蛋',
    })
  })

  it('falls back to the kind label when a session has no summary or note', () => {
    const days: PlanDay[] = [
      {
        date: '2026-07-29',
        sessions: [
          runSession({ date: '2026-07-29', kind: 'rest', summary: '', notes_md: null, spec: null }),
        ],
        nutrition: null,
      },
    ]
    const projection = projectCurrentWeekPlan(days)
    expect(projection.days[0]).toEqual({ label: '2026-07-29', detail: '休息' })
  })
})
