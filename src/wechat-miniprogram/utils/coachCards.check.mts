/**
 * coachCards.ts 自检：
 * `node --import ./utils/ts-resolve-hooks.mjs utils/coachCards.check.mts`。
 * 覆盖 信封→卡片视图（文案/路由/角标）、形状校验拒绝、历史自愈（信封/裸
 * JSON/普通文本）、流式 JSON 探测。
 */
import type { RaceStrategy } from '../services/race-strategy.ts';
import { buildCoachCard, looksLikeJsonText, parseLeakedRaceStrategyEnvelope } from './coachCards.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// 与后端校验自洽的策略 fixture：42.195 km × 5:41/km ≈ 3:59:48。
const strategy: RaceStrategy = {
  race_name: '杭州马拉松',
  item_type: 'Marathon',
  target_finish_time: '3:59:59',
  summary: '前稳后渐进。',
  pace_segments: [
    { segment: '0–42.195 km', distance_km: 42.195, pace: '5:41/km', segment_time: '3:59:48', cumulative_time: '3:59:48', note: '全程匀速' },
  ],
  fueling_plan: [{ time_point: '赛前 30 分钟', content: '能量胶 1 支' }],
  course_tips: ['32km 爬坡提前降档'],
  weather_tips: ['穿背心+臂套'],
  basis_note: '近 90 天 L4 估计。',
};

const raceTarget = { kind: 'race', race_event_id: 30, item_type: 'Marathon' } as const;

// 信封 → 卡片视图：文案与路由由注册表产出
{
  const view = buildCoachCard({ $type: 'race-strategy', data: strategy }, raceTarget);
  if (!view) throw new Error('race-strategy card should build');
  eq(view.title, '比赛策略已生成', 'card title');
  eq(view.subtitle, '杭州马拉松 · 目标 3:59:59，含 1 段配速与补给计划', 'card subtitle');
  eq(view.badge, '初稿', 'card badge');
  eq(view.buttonText, '查看详情', 'card cta');
  eq(view.url, '/pages/race-center/strategy/strategy?id=30', 'card url');
  eq(view.data, strategy, 'card data');
  eq(view.icon, '/assets/icons/flag.svg', 'card icon');
}

// 无 race target：仍出卡片，CTA 兜底到赛事中心
{
  const view = buildCoachCard({ $type: 'race-strategy', data: strategy }, undefined);
  eq(view?.url, '/pages/race-center/race-center', 'card url without target');
}

// 形状不对 / 未知类型 / 非 信封 → null（降级走 markdown 渲染器）
eq(buildCoachCard({ $type: 'race-strategy', data: { race_name: '缺字段' } }, raceTarget), null, 'invalid payload');
eq(buildCoachCard({ $type: 'weekly-plan', data: {} }, raceTarget), null, 'unregistered type');
eq(buildCoachCard(null, raceTarget), null, 'null card');
eq(buildCoachCard({}, raceTarget), null, 'missing $type');

// 自建课卡片（devops#587）：双 CTA（保存到X月X日 / 推送到手表），摘要即卡片
const customWorkoutCard = {
  save_token: '0d6b07d8-0b7e-4f6e-9f2a-2a6f0b3c9d11',
  date: '2026-10-20',
  name: '4km×3 组 + 400m×6 间歇',
  summary: '3 组 4km 巡航 + 6 个 400m 冲刺',
  total_distance_m: 14400,
  total_duration_s: null,
  estimated_dose: null,
  spec: {
    schema: 'run-workout/v1',
    name: '4km×3 组 + 400m×6 间歇',
    date: '2026-10-20',
    note: null,
    blocks: [
      { repeat: 3, steps: [{ step_kind: 'work', duration: { kind: 'distance_m', value: 4000 }, target: { kind: 'pace_s_km', low: 230, high: 240 }, note: null, hr_cap_bpm: null, rest: { kind: 'time_s', value: 180 } }] },
      { repeat: 6, steps: [{ step_kind: 'work', duration: { kind: 'distance_m', value: 400 }, target: { kind: 'pace_s_km', low: 205, high: 215 }, note: null, hr_cap_bpm: null, rest: { kind: 'time_s', value: 90 } }] },
    ],
  },
};
{
  const view = buildCoachCard({ $type: 'custom-workout', data: customWorkoutCard }, undefined);
  if (!view) throw new Error('custom-workout card should build');
  eq(view.type, 'custom-workout', 'custom-workout type');
  eq(view.title, '训练课已创建', 'custom-workout title');
  eq(view.subtitle, '10月20日 · 3 组 4km 巡航 + 6 个 400m 冲刺', 'custom-workout subtitle');
  eq(view.badge, '待保存', 'custom-workout badge');
  eq(view.buttonText, '保存到10月20日', 'custom-workout primary cta');
  eq(view.secondaryButtonText, '推送到手表', 'custom-workout secondary cta');
  eq(view.url, '', 'custom-workout action cta has no navigation');
  eq(view.inlineBody, true, 'custom-workout inline body');
  eq(view.data, customWorkoutCard, 'custom-workout data');
  // 形状不对（缺 blocks / 坏日期 / 空 save_token）→ null 降级
  eq(buildCoachCard({ $type: 'custom-workout', data: { ...customWorkoutCard, spec: { ...customWorkoutCard.spec, blocks: [] } } }, undefined), null, 'custom-workout empty blocks rejected');
  eq(buildCoachCard({ $type: 'custom-workout', data: { ...customWorkoutCard, date: '10月20日' } }, undefined), null, 'custom-workout bad date rejected');
  eq(buildCoachCard({ $type: 'custom-workout', data: { ...customWorkoutCard, save_token: '' } }, undefined), null, 'custom-workout empty save_token rejected');
}

// reissue 卡（devops#698 D）：复用原 save_token 的改内容重发——标题/副标题
// 明示覆盖对象（原日期 · 原课名），CTA 仍是保存/推送双按钮，保存后角标走「已保存」
{
  const view = buildCoachCard({ $type: 'custom-workout', data: { ...customWorkoutCard, reissue: true } }, undefined);
  if (!view) throw new Error('reissue card should build');
  eq(view.title, '训练课已调整', 'reissue title');
  eq(view.subtitle, '将更新 10月20日 · 4km×3 组 + 400m×6 间歇', 'reissue subtitle names the overwritten row');
  eq(view.badge, '待保存', 'reissue badge');
  eq(view.buttonText, '保存到10月20日', 'reissue primary cta');
  eq(view.secondaryButtonText, '推送到手表', 'reissue keeps push cta');
  eq(view.data, { ...customWorkoutCard, reissue: true }, 'reissue keeps card data');
}

// workout-op 确认卡（devops#698 A）：删除/改期单 CTA、角标「待确认」、不可跳转
const workoutOpBase = {
  workout_id: 'c9f3a2e1-8b7d-4c5e-9a0f-1e2d3c4b5a69',
  date: '2026-10-23',
  name: '4km×3 组 + 400m×6 间歇',
  kind: 'run',
  summary: '3 组 4km 巡航',
};
{
  const del = buildCoachCard({ $type: 'workout-op', data: { ...workoutOpBase, op: 'delete', pushed: false } }, undefined);
  if (!del) throw new Error('workout-op delete card should build');
  eq(del.type, 'workout-op', 'workout-op type');
  eq(del.icon, '/assets/icons/delete.svg', 'workout-op delete icon');
  eq(del.title, '删除训练课', 'workout-op delete title');
  eq(del.subtitle, '10月23日 · 4km×3 组 + 400m×6 间歇', 'workout-op delete subtitle');
  eq(del.badge, '待确认', 'workout-op delete badge');
  eq(del.buttonText, '确认删除', 'workout-op delete cta');
  eq(del.secondaryButtonText, '', 'workout-op has no secondary cta');
  eq(del.url, '', 'workout-op action cta has no navigation');
  eq(del.inlineBody, true, 'workout-op inline body');
  eq(del.data, { ...workoutOpBase, op: 'delete', pushed: false }, 'workout-op keeps data for the handler');
  // pushed：删除副标题附「删除将同步移除手表副本」（软删 best-effort 清手表副本）
  const delPushed = buildCoachCard({ $type: 'workout-op', data: { ...workoutOpBase, op: 'delete', pushed: true } }, undefined);
  eq(delPushed?.subtitle, '10月23日 · 4km×3 组 + 400m×6 间歇 · 删除将同步移除手表副本', 'workout-op delete pushed subtitle');
}
{
  const move = buildCoachCard(
    { $type: 'workout-op', data: { ...workoutOpBase, op: 'move', new_date: '2026-10-25', pushed: true } },
    undefined,
  );
  if (!move) throw new Error('workout-op move card should build');
  eq(move.icon, '/assets/icons/schedule.svg', 'workout-op move icon');
  eq(move.title, '训练课改期', 'workout-op move title');
  eq(move.subtitle, '10月23日 → 10月25日 · 4km×3 组 + 400m×6 间歇', 'workout-op move subtitle');
  eq(move.badge, '待确认', 'workout-op move badge');
  eq(move.buttonText, '确认改期', 'workout-op move cta');
}
// 形状不对：未知 op / 缺 workout_id / 坏 date / move 缺/坏 new_date / 缺 name → null 降级 markdown
eq(buildCoachCard({ $type: 'workout-op', data: { ...workoutOpBase, op: 'rename' } }, undefined), null, 'workout-op unknown op rejected');
eq(buildCoachCard({ $type: 'workout-op', data: { ...workoutOpBase, op: 'delete', workout_id: '' } }, undefined), null, 'workout-op empty workout_id rejected');
eq(buildCoachCard({ $type: 'workout-op', data: { ...workoutOpBase, op: 'delete', date: '10月23日' } }, undefined), null, 'workout-op bad date rejected');
eq(buildCoachCard({ $type: 'workout-op', data: { ...workoutOpBase, op: 'delete', name: '' } }, undefined), null, 'workout-op empty name rejected');
eq(buildCoachCard({ $type: 'workout-op', data: { ...workoutOpBase, op: 'move' } }, undefined), null, 'workout-op move without new_date rejected');
eq(buildCoachCard({ $type: 'workout-op', data: { ...workoutOpBase, op: 'move', new_date: '10月25日' } }, undefined), null, 'workout-op move bad new_date rejected');

// 历史自愈：信封 JSON / 裸策略 JSON 捞回；普通文本与坏 JSON 不动
eq(parseLeakedRaceStrategyEnvelope(JSON.stringify({ disposition: 'return_direct', content: strategy })), { $type: 'race-strategy', data: strategy }, 'leaked envelope');
eq(parseLeakedRaceStrategyEnvelope(JSON.stringify(strategy)), { $type: 'race-strategy', data: strategy }, 'leaked bare strategy');
eq(parseLeakedRaceStrategyEnvelope('该赛事内容暂未调研，无法制定策略。'), null, 'plain prose untouched');
eq(parseLeakedRaceStrategyEnvelope('0–10 km 未完待续 {'), null, 'broken json untouched');
eq(parseLeakedRaceStrategyEnvelope(''), null, 'empty untouched');

// master-plan 卡片（#428）：摘要即卡片——正文摘要跟卡片同泡渲染，无跳转目标；
// data 只带渲染/定位需要的标量（时间轴与负荷投影走 markdown 正文）
const masterPlanCard = {
  goal: { race_name: '无锡马拉松', distance: 'FM', race_date: '2027-03-21', target_time: '3:30:00' },
  start_date: '2026-10-05',
  end_date: '2027-03-21',
  total_weeks: 24,
};
{
  const view = buildCoachCard({ $type: 'master-plan', data: masterPlanCard }, raceTarget);
  if (!view) throw new Error('master-plan card should build');
  eq(view.type, 'master-plan', 'master-plan type');
  eq(view.icon, '/assets/icons/calendar_month.svg', 'master-plan icon');
  eq(view.title, '赛季训练计划已生成', 'master-plan title');
  eq(view.subtitle, '无锡马拉松（全马） · 24 周备赛，目标 3:30:00', 'master-plan subtitle');
  eq(view.badge, '初稿', 'master-plan badge');
  eq(view.buttonText, '', 'master-plan cta empty without apply payload (#585 降级卡片)');
  eq(view.secondaryButtonText, '', 'master-plan secondary empty');
  eq(view.url, '', 'master-plan no navigation');
  eq(view.inlineBody, true, 'master-plan inline body');
  eq(view.data, masterPlanCard, 'master-plan data');
}
// #585：带 content+apply_token 的卡片出「应用」单 CTA（动作型，不走 url）
{
  const applicable = {
    ...masterPlanCard,
    apply_token: 'b34c6d7e-1111-4222-8333-444455556666',
    content: { goal: { goal_id: 'g1' }, phases: [], milestones: [], weeks: [] },
  };
  const withPayload = buildCoachCard({ $type: 'master-plan', data: applicable }, raceTarget);
  eq(withPayload?.buttonText, '应用', 'master-plan apply cta');
  eq(withPayload?.secondaryButtonText, '', 'master-plan no abandon cta (#585 draft 下线)');
  eq(withPayload?.url, '', 'master-plan action cta has no navigation');
  eq(withPayload?.data, applicable, 'master-plan keeps content+apply_token for the handler');
}
// #429 旧卡片（只带 plan_id）：draft 已下线，无 CTA
{
  const legacy = buildCoachCard({ $type: 'master-plan', data: { ...masterPlanCard, plan_id: 'plan-1' } }, raceTarget);
  eq(legacy?.buttonText, '', 'legacy card has no cta');
}
// 完赛为目标（无 target_time）：副标题不拼目标段
{
  const finishOnly = buildCoachCard(
    { $type: 'master-plan', data: { ...masterPlanCard, goal: { ...masterPlanCard.goal, target_time: '' } } },
    undefined,
  );
  eq(finishOnly?.subtitle, '无锡马拉松（全马） · 24 周备赛', 'master-plan subtitle without target');
}
// 形状不对 → null（降级 markdown）
eq(buildCoachCard({ $type: 'master-plan', data: { goal: { race_name: '缺字段' } } }, raceTarget), null, 'master-plan invalid payload');

// 流式 JSON 探测（呈现层占位）：裸 JSON / DeepSeek echo 前缀 / 正文含信封头
eq(looksLikeJsonText('{"disposition": "return_direct"'), true, 'json prefix detected');
eq(looksLikeJsonText('Returning structured response: {"disposition":"return_direct",…'), true, 'deepseek echo prefix detected');
eq(looksLikeJsonText('正'.repeat(130) + '"disposition"'), false, 'disposition beyond 120 chars not flagged');
eq(looksLikeJsonText('## 杭州马拉松 · 比赛策略'), false, 'markdown not flagged');
eq(looksLikeJsonText('  \n{"a": 1}'), true, 'leading whitespace json');

console.log('coachCards.check passed');
