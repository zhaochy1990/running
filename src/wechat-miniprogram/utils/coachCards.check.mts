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
  eq(view.buttonText, '查看并应用', 'card cta');
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

// 历史自愈：信封 JSON / 裸策略 JSON 捞回；普通文本与坏 JSON 不动
eq(parseLeakedRaceStrategyEnvelope(JSON.stringify({ disposition: 'return_direct', content: strategy })), { $type: 'race-strategy', data: strategy }, 'leaked envelope');
eq(parseLeakedRaceStrategyEnvelope(JSON.stringify(strategy)), { $type: 'race-strategy', data: strategy }, 'leaked bare strategy');
eq(parseLeakedRaceStrategyEnvelope('该赛事内容暂未调研，无法制定策略。'), null, 'plain prose untouched');
eq(parseLeakedRaceStrategyEnvelope('0–10 km 未完待续 {'), null, 'broken json untouched');
eq(parseLeakedRaceStrategyEnvelope(''), null, 'empty untouched');

// 流式 JSON 探测（呈现层占位）：裸 JSON / DeepSeek echo 前缀 / 正文含信封头
eq(looksLikeJsonText('{"disposition": "return_direct"'), true, 'json prefix detected');
eq(looksLikeJsonText('Returning structured response: {"disposition":"return_direct",…'), true, 'deepseek echo prefix detected');
eq(looksLikeJsonText('正'.repeat(130) + '"disposition"'), false, 'disposition beyond 120 chars not flagged');
eq(looksLikeJsonText('## 杭州马拉松 · 比赛策略'), false, 'markdown not flagged');
eq(looksLikeJsonText('  \n{"a": 1}'), true, 'leading whitespace json');

console.log('coachCards.check passed');
