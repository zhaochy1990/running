/**
 * workoutSegments.ts 自检（devops#703：workout-detail 与 workout-share 共用的
 * 分段渲染语言）：
 * `node --import ./utils/ts-resolve-hooks.mjs utils/workoutSegments.check.mts`。
 * 覆盖 跑课分段组（×N/步后休息独立行/心率帽）、力量动作行（次数/时长/组间休息）。
 */
import type { NormalizedRunWorkout, NormalizedStrengthWorkout } from '../types/plan.ts';
import { buildExerciseRows, buildRunGroups } from './workoutSegments.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

const runSpec: NormalizedRunWorkout = {
  schema: 'run-workout/v1',
  name: '间歇课',
  date: '2026-10-20',
  note: '配速区间取中间值',
  blocks: [
    {
      repeat: 2,
      steps: [
        { step_kind: 'warmup', duration: { kind: 'distance_m', value: 2000 }, target: { kind: 'pace_s_km', low: 320, high: 330 }, note: null },
        { step_kind: 'work', duration: { kind: 'distance_m', value: 800 }, target: { kind: 'pace_s_km', low: 245, high: 255 }, note: '  保持节奏 ', hr_cap_bpm: 172, rest: { kind: 'time_s', value: 90 } },
      ],
    },
    { repeat: 1, steps: [{ step_kind: 'cooldown', duration: { kind: 'time_s', value: 600 }, target: { kind: 'open', low: null, high: null }, note: null }] },
  ],
};

const groups = buildRunGroups(runSpec);
eq(groups.length, 2, 'block 组数');
eq(groups[0].repeat, 2, 'repeat 透传');
// 第一组：热身行 + 主课行（心率帽+note trim）+ 步后休息独立行
eq(groups[0].rows.length, 3, '步后休息展开为独立行');
eq(groups[0].rows[0].main, '2 km · 5:20–5:30/km', '距离段+pace 区间');
eq(groups[0].rows[1].main, '800 m · 4:05–4:15/km', '距离段 m/km 换算');
eq(groups[0].rows[1].hrCapText, '心率≤172', '心率帽');
eq(groups[0].rows[1].note, '保持节奏', 'note trim');
eq(groups[0].rows[2].kindLabel, '休息', '休息行标签');
eq(groups[0].rows[2].quiet, true, '休息行 quiet');
eq(groups[0].rows[2].main, '90 秒', '90 秒休息（<120s 口语秒）');
// 第二组：open 段
eq(groups[1].rows[0].main, '10:00 · 体感', '时长段+体感目标');
eq(groups[1].rows.length, 1, '无 rest 不加行');

const strengthSpec: NormalizedStrengthWorkout = {
  schema: 'strength-workout/v1',
  name: '核心力量',
  date: '2026-10-21',
  note: null,
  exercises: [
    { canonical_id: 'plank', display_name: '平板支撑', sets: 3, target_kind: 'time_s', target_value: 45, rest_seconds: 60, note: null },
    { canonical_id: 'squat', display_name: '', sets: 3, target_kind: 'reps', target_value: 12, rest_seconds: 0, note: '膝盖对齐脚尖' },
  ],
};

const rows = buildExerciseRows(strengthSpec);
eq(rows.length, 2, '动作行数');
eq(rows[0].name, '平板支撑', 'display_name 优先');
eq(rows[0].target, '3 组 × 0:45', '时长目标（clock 形态）');
eq(rows[0].rest, '组间休息 60 秒', '组间休息');
eq(rows[1].name, 'squat', 'display_name 缺失回退 canonical_id');
eq(rows[1].target, '3 组 × 12 次', '次数目标');
eq(rows[1].rest, '', 'rest_seconds=0 → 空');
eq(rows[1].note, '膝盖对齐脚尖', '动作备注');

console.log('workoutSegments.check: all assertions passed');
