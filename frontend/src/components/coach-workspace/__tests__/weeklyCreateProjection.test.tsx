import { describe, expect, it } from 'vitest'

import { projectWeeklyCreate } from '../weeklyCreateProjection'

const CANONICAL_PLAN = {
  plan: {
    schema: 'weekly-plan/v1',
    week_folder: '2026-07-20_07-26',
    notes_md: '本周重点：**恢复**为主，控制强度。',
    sessions: [
      { date: '2026-07-20', session_index: 0, kind: 'run', summary: '轻松跑 8 km' },
      {
        date: '2026-07-21',
        session_index: 0,
        kind: 'strength',
        summary: '下肢力量',
        spec: {
          name: '下肢力量 A',
          note: '动作缓慢控制',
          exercises: [
            {
              canonical_id: 'T1262',
              display_name: '高脚杯深蹲',
              sets: 3,
              target_kind: 'reps',
              target_value: 12,
              rest_seconds: 90,
              note: '核心收紧',
            },
            {
              canonical_id: 'T1300',
              display_name: '平板支撑',
              sets: 3,
              target_kind: 'time_s',
              target_value: 45,
              rest_seconds: 60,
            },
          ],
        },
      },
      { date: '2026-07-22', session_index: 0, kind: 'rest', summary: '休息' },
    ],
    nutrition: [
      {
        date: '2026-07-20',
        kcal_target: 2400,
        carbs_g: 320,
        protein_g: 130,
        fat_g: 70,
        water_ml: 2500,
        notes_md: '跑后补糖',
        meals: [
          { name: '早餐', time_hint: '7:30', kcal: 600, carbs_g: 80, protein_g: 25, fat_g: 15, items_md: '燕麦 + 鸡蛋' },
          { name: '午餐', kcal: 800 },
        ],
      },
    ],
  },
}

describe('projectWeeklyCreate', () => {
  it('keeps every session on the training calendar, including strength', () => {
    const { days } = projectWeeklyCreate(CANONICAL_PLAN)
    expect(days).toEqual([
      { label: '2026-07-20', detail: '轻松跑 8 km' },
      { label: '2026-07-21', detail: '下肢力量' },
      { label: '2026-07-22', detail: '休息' },
    ])
  })

  it('uses localized labels when a session has no summary or note', () => {
    const { days } = projectWeeklyCreate({
      plan: {
        sessions: [
          { date: '2026-07-20', kind: 'rest' },
          { date: '2026-07-21', kind: 'cross' },
        ],
      },
    })
    expect(days).toEqual([
      { label: '2026-07-20', detail: '休息' },
      { label: '2026-07-21', detail: '交叉训练' },
    ])
  })

  it('shows multiple sessions on the same day as separate calendar rows', () => {
    const { days } = projectWeeklyCreate({
      plan: {
        sessions: [
          { date: '2026-07-20', session_index: 0, kind: 'run', summary: '晨跑 6 km' },
          { date: '2026-07-20', session_index: 1, kind: 'strength', summary: '晚间力量' },
        ],
      },
    })
    expect(days).toEqual([
      { label: '2026-07-20', detail: '晨跑 6 km' },
      { label: '2026-07-20', detail: '晚间力量' },
    ])
  })

  it('projects strength sessions into a standalone section with formatted targets', () => {
    const { strength } = projectWeeklyCreate(CANONICAL_PLAN)
    expect(strength).toEqual([
      {
        label: '2026-07-21',
        title: '下肢力量 A',
        note: '动作缓慢控制',
        exercises: [
          { name: '高脚杯深蹲', sets: 3, target: '12 次', rest: '休息 90 秒', note: '核心收紧' },
          { name: '平板支撑', sets: 3, target: '45 秒', rest: '休息 60 秒', note: null },
        ],
      },
    ])
  })

  it('projects nutrition days with macros, water, and meals', () => {
    const { nutrition } = projectWeeklyCreate(CANONICAL_PLAN)
    expect(nutrition).toEqual([
      {
        label: '2026-07-20',
        kcalTarget: 2400,
        carbsG: 320,
        proteinG: 130,
        fatG: 70,
        waterMl: 2500,
        notesMd: '跑后补糖',
        meals: [
          { name: '早餐', timeHint: '7:30', kcal: 600, carbsG: 80, proteinG: 25, fatG: 15, itemsMd: '燕麦 + 鸡蛋' },
          { name: '午餐', timeHint: null, kcal: 800, carbsG: null, proteinG: null, fatG: null, itemsMd: null },
        ],
      },
    ])
  })

  it('surfaces the plan-level weekly note', () => {
    expect(projectWeeklyCreate(CANONICAL_PLAN).notesMd).toBe('本周重点：**恢复**为主，控制强度。')
  })

  it('accepts a bare WeeklyPlan (no outer plan wrapper)', () => {
    const { days } = projectWeeklyCreate(CANONICAL_PLAN.plan)
    expect(days).toEqual([
      { label: '2026-07-20', detail: '轻松跑 8 km' },
      { label: '2026-07-21', detail: '下肢力量' },
      { label: '2026-07-22', detail: '休息' },
    ])
  })

  it('degrades malformed input to empty surfaces without throwing', () => {
    expect(projectWeeklyCreate(null)).toEqual({
      days: [],
      strength: [],
      nutrition: [],
      notesMd: null,
    })
    expect(projectWeeklyCreate({ plan: { sessions: 'nope', nutrition: 42 } })).toEqual({
      days: [],
      strength: [],
      nutrition: [],
      notesMd: null,
    })
  })

  it('skips exercises and meals missing a usable name', () => {
    const projection = projectWeeklyCreate({
      plan: {
        sessions: [
          {
            date: '2026-07-21',
            kind: 'strength',
            spec: { exercises: [{ sets: 3, target_kind: 'reps', target_value: 10 }] },
          },
        ],
        nutrition: [{ date: '2026-07-20', meals: [{ kcal: 500 }] }],
      },
    })
    expect(projection.strength[0].exercises).toEqual([])
    expect(projection.nutrition[0].meals).toEqual([])
  })
})
