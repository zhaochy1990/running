/**
 * injuryFlow.ts 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/injuryFlow.check.mts`。
 * 覆盖：问句形态分流 / 三组选项文案 / enter·checkin·doctor 结果文案 /
 * 比赛临近窗口 / 提示条文案。不依赖小程序运行时。
 */
import {
  INJURY_CHECKIN_OPTIONS,
  INJURY_DOCTOR_OPTIONS,
  INJURY_VERDICT_OPTIONS,
  checkinResultText,
  doctorResultText,
  enterResultText,
  injuryAskKind,
  injuryAskQuestion,
  injuryBannerText,
  raceClosingWithinWeeks,
} from './injuryFlow.ts';
import type { PlanInjuryState } from '../types/adjustment';

const injury = (extra: Partial<PlanInjuryState> = {}): PlanInjuryState =>
  ({
    user_id: 'u1',
    master_plan_id: 'p1',
    mode: 'reduced',
    detail: '左膝外侧疼',
    maintenance_km: 25,
    needs_verdict: false,
    last_checkin_day: '2026-11-09',
    last_checkin_answer: 'same',
    ...extra,
  }) as PlanInjuryState;

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// —— 问句形态分流：needs_verdict > pending_doctor > 常规轻问；无伤病 null ——
eq(injuryAskKind(null), null, '无伤病不问');
eq(injuryAskKind(injury()), 'checkin', '常规态走轻问');
eq(injuryAskKind(injury({ mode: 'pending_doctor' })), 'doctor', '待定态问医生');
eq(injuryAskKind(injury({ mode: 'pending_doctor', needs_verdict: true })), 'verdict', '加重优先重判');
eq(injuryAskQuestion('checkin'), '伤怎么样了？', '轻问问句');
eq(injuryAskQuestion('doctor'), '医生怎么说？', '医生问句');
eq(injuryAskQuestion('verdict'), '伤有变化，现在的情况是？', '重判问句');

// —— 三组选项与后端枚举对齐 ——
eq(
  INJURY_VERDICT_OPTIONS.map((o) => o.value),
  ['continue', 'reduced', 'rest', 'undecided'],
  '四选一 value 枚举',
);
eq(INJURY_VERDICT_OPTIONS[3].label, '判断不了，先看医生', '看医生选项文案');
eq(
  INJURY_CHECKIN_OPTIONS.map((o) => o.value),
  ['better', 'same', 'worse', 'recovered'],
  '轻问四键 value 枚举',
);
eq(INJURY_CHECKIN_OPTIONS.map((o) => o.label).join('/'), '好转/持平/加重/恢复了', '轻问四键文案');
eq(
  INJURY_DOCTOR_OPTIONS.map((o) => o.value),
  ['continue', 'reduced', 'rest'],
  '医生三键 value 枚举（无 undecided）',
);

// —— enter 结果文案（按 verdict 差异化） ——
eq(enterResultText('continue', false), '好的，计划照旧；伤情有变随时告诉我', 'continue 文案');
eq(
  enterResultText('reduced', false),
  '已进入维持训练：E 有氧为主量减半，去质量课；每天会问你恢复情况',
  'reduced 文案',
);
eq(enterResultText('rest', false), '已暂停出课，安心养伤；每天会问你恢复情况', 'rest 文案');
eq(enterResultText('undecided', false), '看完医生回来告诉我结论（每天都会问一次）', 'undecided 文案');

// —— checkin 结果文案：recovered 退出 / worse 转重判 / better·same 记录 ——
eq(checkinResultText('recovered', null), '已退出伤病模式，训练会按你的最新状态接回', 'recovered 文案');
eq(checkinResultText('recovered', injury()), '已退出伤病模式，训练会按你的最新状态接回', 'recovered 以答案为准');
eq(checkinResultText('worse', injury({ needs_verdict: true })), '收到，先看看现在的情况能怎么练', 'worse 转重判文案');
eq(checkinResultText('better', injury()), '已记录，量会随恢复情况回抬', 'better 文案');
eq(checkinResultText('same', injury()), '已记录，量会随恢复情况回抬', 'same 文案');

// —— doctor 结果文案 ——
eq(doctorResultText('continue', true), '好的，计划照旧；伤情有变随时告诉我', 'doctor continue');
eq(doctorResultText('reduced', false), '已进入维持训练：E 有氧为主量减半，去质量课；每天会问你恢复情况', 'doctor reduced');
eq(doctorResultText('rest', false), '已暂停出课，安心养伤；每天会问你恢复情况', 'doctor rest');

// —— 比赛临近（≤4 周）：边界 28 天含、29 天不含、已过/非法 false ——
eq(raceClosingWithinWeeks('2026-12-08', '2026-11-10'), true, '28 天（4 周整）算临近');
eq(raceClosingWithinWeeks('2026-12-09', '2026-11-10'), false, '29 天不算');
eq(raceClosingWithinWeeks('2026-11-10', '2026-11-10'), true, '比赛今天算临近');
eq(raceClosingWithinWeeks('2026-11-09', '2026-11-10'), false, '比赛已过不算');
eq(raceClosingWithinWeeks(null, '2026-11-10'), false, '无比赛日期不算');
eq(raceClosingWithinWeeks('bad', '2026-11-10'), false, '非法日期不算');

// —— 训练计划页提示条文案 ——
eq(injuryBannerText('reduced'), '伤病维持训练中 · 量随恢复回抬', 'reduced 提示条');
eq(injuryBannerText('rest'), '伤病停训中 · 每日记录恢复状态', 'rest 提示条');
eq(injuryBannerText('pending_doctor'), '伤病维持训练中 · 量随恢复回抬', '待定态回落 reduced 文案');

console.log('injuryFlow.check: all passed');
