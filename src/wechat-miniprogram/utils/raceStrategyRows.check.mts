/**
 * raceStrategyRows.ts 自检：
 * `node --import ./utils/ts-resolve-hooks.mjs utils/raceStrategyRows.check.mts`。
 * 覆盖 配速解析/格式化、用时=距离×配速换算与累计、视图往返（编辑回收）、
 * 分享标题、「设为目标」的距离映射与预填。
 */
import type { RaceStrategy } from '../services/race-strategy.ts';
import {
  formatDuration,
  formatPace,
  fromStrategyView,
  goalDistanceOf,
  goalPrefill,
  parsePaceSPerKm,
  raceDayLabel,
  recomputePaceTimes,
  strategyShareTitle,
  toStrategyView,
} from './raceStrategyRows.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// 配速解析与格式化
eq(parsePaceSPerKm('5:40/km'), 340, 'pace parse 5:40/km');
eq(parsePaceSPerKm('05:40'), 340, 'pace parse 无单位');
eq(parsePaceSPerKm('5:70/km'), null, 'pace 秒位非法');
eq(parsePaceSPerKm('很快'), null, 'pace 非数字');
eq(formatPace(340), '5:40/km', 'pace format');
eq(formatDuration(3450), '57:30', 'duration <1h');
eq(formatDuration(14399), '3:59:59', 'duration h:mm:ss');
eq(raceDayLabel('2026-10-18T01:30:00Z'), '2026/10/18', 'race day label');

// 用时=距离×配速 + 累计
const rows = [
  { index: 0, segment: '0–10 km', distanceKm: 10, pace: '5:45/km', segmentTime: '', cumulativeTime: '', note: '' },
  { index: 1, segment: '10–21.1 km', distanceKm: 11.1, pace: '5:40/km', segmentTime: '', cumulativeTime: '', note: '' },
  { index: 2, segment: '32 km 爬坡', distanceKm: null, pace: '6:10/km', segmentTime: '35:12', cumulativeTime: '3:05:00', note: '' },
];
const computed = recomputePaceTimes(rows);
eq(computed[0].segmentTime, '57:30', 'seg0 time');
eq(computed[0].cumulativeTime, '57:30', 'seg0 cumulative');
eq(computed[1].segmentTime, '1:02:54', 'seg1 time (四舍五入)');
eq(computed[1].cumulativeTime, '2:00:24', 'seg1 cumulative');
eq(computed[2].segmentTime, '35:12', '无距离行保持原文本');

// 视图往返：编辑 pace/note 后回收，字段带回
const strategy: RaceStrategy = {
  race_name: '杭州马拉松',
  item_type: 'Marathon',
  target_finish_time: '3:59:59',
  summary: '前稳后渐进。',
  pace_segments: [
    { segment: '0–10 km', distance_km: 10, pace: '5:45/km', segment_time: '57:30', cumulative_time: '57:30', note: '压住兴奋' },
    { segment: '10–21.1 km', distance_km: 11.1, pace: '5:40/km', segment_time: '1:02:54', cumulative_time: '2:00:24', note: '' },
  ],
  fueling_plan: [
    { time_point: '赛前 30 分钟', content: '能量胶 1 支' },
    { time_point: '20 km', content: '能量胶 1 支' },
    { time_point: '', content: '' },
  ],
  course_tips: ['32km 爬坡提前降档'],
  weather_tips: ['穿背心+臂套'],
  basis_note: '近 90 天 L4 估计。',
};
const view = toStrategyView(strategy);
eq(view.itemTypeLabel, '全马', 'item type label 全马');
eq(view.paceRows[0].segmentTime, '57:30', 'view 换算');
view.paceRows[0].pace = '5:40/km';
view.fuelingRows = view.fuelingRows.filter((r) => r.timePoint || r.content);
const saved = fromStrategyView(view, strategy);
eq(saved.pace_segments[0].pace, '5:40/km', '编辑回收 pace');
eq(saved.pace_segments[0].segment_time, '56:40', '编辑后重算用时');
eq(saved.pace_segments[0].cumulative_time, '56:40', '编辑后重算累计');
eq(saved.fueling_plan.length, 2, '空补给行被过滤');

// 分享与目标映射
eq(strategyShareTitle(view), '我的杭州马拉松比赛策略 · 目标 3:59:59', 'share title');
eq(goalDistanceOf('Marathon'), 'FM', 'FM 映射');
eq(goalDistanceOf('HalfMarathon'), 'HM', 'HM 映射');
eq(goalDistanceOf('10Km'), '10K', '10K 映射');
eq(goalDistanceOf('Other'), null, '不可映射 → null');
const prefill = goalPrefill(view, '2026-11-01', '杭州市');
eq(
  prefill && { d: prefill.race_distance, n: prefill.race_name, t: prefill.target_finish_time, l: prefill.race_location },
  { d: 'FM', n: '杭州马拉松', t: '3:59:59', l: '杭州市' },
  'goal prefill',
);

console.log('raceStrategyRows self-check passed');
