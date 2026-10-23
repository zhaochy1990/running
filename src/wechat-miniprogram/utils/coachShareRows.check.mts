/**
 * coachShareRows.ts 自检：
 * `node --import ./utils/ts-resolve-hooks.mjs utils/coachShareRows.check.mts`。
 * 覆盖 快照消息→阅读端视图模型：user 气泡 / assistant markdown / race-strategy
 * 静态摘要卡（替代正文）/ master-plan 卡头+inlineBody 正文 / 动作卡与未知信封
 * 降级 markdown / 原始 HTML inert。
 */
import { buildCoachShareMessages } from './coachShareRows.ts';
import type { CoachShareMessage } from '../services/coach.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// 与 coachCards.check.mts 同口径的策略 fixture。
const strategy = {
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

const masterPlan = {
  goal: { race_name: '杭州马拉松', distance: 'FM', target_time: '3:59:59' },
  total_weeks: 8,
  content: { weeks: [] },
};

const messages: CoachShareMessage[] = [
  { role: 'user', content: '教练，我下月跑杭马。' },
  { role: 'assistant', content: '**目标** 3:59:59。' },
  { role: 'assistant', content: '## 杭州马拉松 · 比赛策略\n正文初稿', card: { $type: 'race-strategy', data: strategy } },
  { role: 'assistant', content: '# 赛季计划摘要', card: { $type: 'master-plan', data: masterPlan } },
  // 动作卡（待保存）：对只读者无意义 → 降级 markdown
  {
    role: 'assistant',
    content: '训练课已创建。',
    card: {
      $type: 'custom-workout',
      data: {
        save_token: 'tok',
        date: '2026-10-26',
        name: '轻松跑',
        summary: '6km',
        spec: { blocks: [{ kind: 'run', minutes: 36 }] },
      },
    },
  },
  // 未知信封 → 降级 markdown
  { role: 'assistant', content: '未知产物。', card: { $type: 'weekly-plan', data: {} } },
  // 原始 HTML 必须 inert
  { role: 'assistant', content: '<script>alert(1)</script>' },
];

const vms = buildCoachShareMessages(messages);

// user：纯文本气泡，无 html 无卡片
eq(vms[0]?.role, 'user', 'msg0 role');
eq(vms[0]?.html, '', 'msg0 html');
eq(vms[0]?.card, null, 'msg0 card');

// assistant markdown：html 渲染
eq(vms[1]?.html, '<p><strong>目标</strong> 3:59:59。</p>', 'msg1 html');

// race-strategy：静态摘要卡替代正文（html 清空），文案来自注册表
eq(vms[2]?.card?.title, '比赛策略已生成', 'msg2 card title');
eq(
  vms[2]?.card?.subtitle,
  '杭州马拉松 · 目标 3:59:59，含 1 段配速与补给计划',
  'msg2 card subtitle',
);
eq(vms[2]?.card?.inlineBody, false, 'msg2 inlineBody');
eq(vms[2]?.html, '', 'msg2 html suppressed');

// master-plan：卡头 + inlineBody 正文照常渲染
eq(vms[3]?.card?.title, '赛季训练计划已生成', 'msg3 card title');
eq(vms[3]?.card?.inlineBody, true, 'msg3 inlineBody');
eq(vms[3]?.html, '<h1>赛季计划摘要</h1>', 'msg3 html kept');

// custom-workout 动作卡 → 降级 markdown 气泡
eq(vms[4]?.card, null, 'msg4 card degraded');
eq(vms[4]?.html, '<p>训练课已创建。</p>', 'msg4 html');

// 未知信封 → 降级 markdown 气泡
eq(vms[5]?.card, null, 'msg5 card degraded');
eq(vms[5]?.html, '<p>未知产物。</p>', 'msg5 html');

// 原始 HTML inert
eq(vms[6]?.html, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>', 'msg6 html escaped');

console.log('coachShareRows.check: all assertions passed');
