/**
 * lapPaceMarks 自检：`node utils/lapRows.check.mts`（或 `pnpm test`）。
 * 只覆盖判定规则，不依赖小程序运行时。
 */
import type { Segment } from '../types/activity';
import { lapPaceMarks } from './lapRows.ts';

const lap = (km: number | null, pace: number | null, segName = '训练'): Segment =>
  ({ distance_km: km, avg_pace: pace, seg_name: segName, mode: 2 }) as Segment;
const rest = (km: number | null, pace: number | null): Segment => lap(km, pace, '恢复');
// exercise_type=0 的恢复圈后端会回落成 seg_name「训练」，靠原始 mode 3 认出来
const restMode = (km: number | null, pace: number | null): Segment =>
  ({ distance_km: km, avg_pace: pace, seg_name: '训练', mode: 3 }) as Segment;

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// 均匀整公里圈：变快 up / 持平无箭头 / 变慢 down + 最快最慢标记
const steady = lapPaceMarks([lap(1, 300), lap(1, 290), lap(1, 290), lap(1, 320)]);
eq(steady.map((m) => m.trend), ['', 'up', '', 'down'], 'steady arrows');
eq(steady.map((m) => m.tag), ['', '最快', '', '最慢'], 'steady tags');
eq(steady.map((m) => m.rowClass), ['', 'lap-row--fastest', '', 'lap-row--slowest'], 'steady rowClass');

// 收尾残圈（18m）也是圈：全场最快 / 最慢不分距离一类一起排；箭头跟紧邻上一圈比
const withTail = lapPaceMarks([lap(1, 300), lap(1, 310), lap(1, 320), lap(0.0188, 200)]);
eq(withTail.map((m) => m.tag), ['', '', '最慢', '最快'], 'tail lap counts as a lap');
eq(withTail.map((m) => m.trend), ['', 'down', 'down', 'up'], 'arrow compares with the previous lap');

// 最快 / 最慢按配速（s/km）比，不按 duration_s：0.90km 用 250s 比 1.10km 用 300s 更耗时短，
// 但后者配速更快（272.7 < 277.8），最快必须落在后者
const mixedDistance = lapPaceMarks([lap(0.9, 277.8), lap(1.1, 272.7), lap(1, 300)]);
eq(mixedDistance.map((m) => m.tag), ['', '最快', '最慢'], 'ranked by pace, not duration');

// 真实一场间歇课（prod label 480219023439594378，800m 快 / 400m 慢 / 30-110m 恢复）：
// 恢复圈不计圈号也不能上榜，最快 = 第 15 圈 3'40".65，最慢 = 第 2 圈 4'28".63；
// 箭头跨过恢复圈，跟上一「有圈号」圈比。
const intervals = lapPaceMarks([
  lap(0.8, 225.46),
  lap(0.4, 268.63),
  lap(0.8, 227.6),
  rest(0.0693, 2523.36),
  lap(0.8, 226.72),
  lap(0.4, 268),
  lap(0.8, 225.53),
  rest(0.0373, 4640.88),
  lap(0.8, 226.47),
  lap(0.4, 260.76),
  lap(0.8, 222.15),
  rest(0.0842, 2107.23),
  lap(0.8, 226.2),
  lap(0.4, 265.2),
  lap(0.8, 220.65),
  rest(0.0374, 4811.56),
  lap(0.8, 228.2),
  lap(0.4, 254.07),
  lap(0.8, 220.85),
  rest(0.0328, 5496.18),
  lap(0.8, 223.95),
  lap(0.4, 258.27),
  lap(0.8, 224.48),
  rest(0.0134, 2761.34),
]);
eq(
  intervals.map((m, i) => (m.tag ? `${i + 1}:${m.tag}` : null)).filter(Boolean),
  ['2:最慢', '15:最快'],
  'interval tags (rest laps excluded)',
);
eq(
  intervals.map((m) => m.rest),
  [false, false, false, true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false, true],
  'rest flags',
);
eq(
  intervals.map((m) => m.trend),
  ['', 'down', 'up', '', 'up', 'down', 'up', '', 'down', 'down', 'up', '', 'down', 'down', 'up', '', 'down', 'down', 'up', '', 'down', 'down', 'up', ''],
  'arrows skip rest laps',
);

// mode=3 但 seg_name 回落成「训练」的恢复圈同样要排除
const byMode = lapPaceMarks([lap(0.8, 225), restMode(0.05, 2500), lap(0.8, 230), lap(0.8, 228)]);
eq(
  byMode.map((m) => m.rest),
  [false, true, false, false],
  'mode 3 rest lap',
);
eq(
  byMode.map((m, i) => (m.tag ? `${i + 1}:${m.tag}` : null)).filter(Boolean),
  ['1:最快', '3:最慢'],
  'mode 3 lap excluded from ranking',
);

// 圈数太少（< 3 可排名圈）或配速缺失时不标最快 / 最慢eq(lapPaceMarks([lap(1, 300), lap(1, 320)]).map((m) => m.tag), ['', ''], 'min rankable laps');
eq(lapPaceMarks([lap(1, null), lap(1, null), lap(1, null)]).map((m) => m.tag), ['', '', ''], 'missing pace');

console.log('lapRows.check: OK');
