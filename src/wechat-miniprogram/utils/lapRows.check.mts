/**
 * lapPaceMarks 自检：`node utils/lapRows.check.mts`（或 `pnpm test`）。
 * 只覆盖判定规则，不依赖小程序运行时。
 */
import type { Lap } from '../types/activity';
import { lapPaceMarks } from './lapRows.ts';

const lap = (km: number | null, pace: number | null): Lap => ({ distance_km: km, avg_pace: pace }) as Lap;

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// 均匀整公里圈：变快 ↗ / 持平无箭头 / 变慢 ↘ + 最快最慢标记
const steady = lapPaceMarks([lap(1, 300), lap(1, 290), lap(1, 290), lap(1, 320)]);
eq(steady.map((m) => m.arrow), ['', '↗', '', '↘'], 'steady arrows');
eq(steady.map((m) => m.tag), ['', '最快', '', '最慢'], 'steady tags');
eq(steady.map((m) => m.rowClass), ['', 'lap-row--fastest', '', 'lap-row--slowest'], 'steady rowClass');

// 收尾残圈（18m，配速 200 全场最快）必须被排除，否则 最快 会落在它身上
const withTail = lapPaceMarks([lap(1, 300), lap(1, 310), lap(1, 320), lap(0.0188, 200)]);
eq(withTail.map((m) => m.tag), ['最快', '', '最慢', ''], 'tail-lap excluded');
eq(withTail.map((m) => m.arrow), ['', '↘', '↘', ''], 'tail-lap has no arrow');

// 最快 / 最慢按配速（s/km）比，不按 duration_s：0.90km 用 250s 比 1.10km 用 300s 更耗时短，
// 但后者配速更快（272.7 < 277.8），最快必须落在后者
const mixedDistance = lapPaceMarks([lap(0.9, 277.8), lap(1.1, 272.7), lap(1, 300)]);
eq(mixedDistance.map((m) => m.tag), ['', '最快', '最慢'], 'ranked by pace, not duration');

// 真实一场间歇课（prod label 480219023439594378，800m 快 / 400m 慢 / 30-110m 停顿）：
// 停顿圈（配速 40'+/km）不参与，最快 = 第 15 圈 3'40".65，最慢 = 第 2 圈 4'28".63；
// 箭头只在同类圈之间（400m 恢复圈之间、800m 快圈之间），停顿圈一律没有箭头。
const intervals = lapPaceMarks([
  lap(0.8, 225.46),
  lap(0.4, 268.63),
  lap(0.8, 227.6),
  lap(0.0693, 2523.36),
  lap(0.8, 226.72),
  lap(0.4, 268),
  lap(0.8, 225.53),
  lap(0.0373, 4640.88),
  lap(0.8, 226.47),
  lap(0.4, 260.76),
  lap(0.8, 222.15),
  lap(0.0842, 2107.23),
  lap(0.8, 226.2),
  lap(0.4, 265.2),
  lap(0.8, 220.65),
  lap(0.0374, 4811.56),
  lap(0.8, 228.2),
  lap(0.4, 254.07),
  lap(0.8, 220.85),
  lap(0.0328, 5496.18),
  lap(0.8, 223.95),
  lap(0.4, 258.27),
  lap(0.8, 224.48),
  lap(0.0134, 2761.34),
]);
eq(intervals.map((m) => m.tag), ['', '最慢', '', '', '', '', '', '', '', '', '', '', '', '', '最快', '', '', '', '', '', '', '', '', ''], 'interval tags');
eq(intervals[14].arrow, '↗', 'rep 15 faster than rep 13');
eq(intervals[16].arrow, '↘', 'rep 17 slower than rep 15');
eq(intervals[5].arrow, '↗', 'recovery laps compare with each other');
eq(intervals[1].arrow, '', 'first 400m recovery has no same-class lap');
for (const rest of [3, 7, 11, 15, 19, 23]) eq(intervals[rest].arrow, '', `rest lap ${rest + 1} has no arrow`);

// 圈数太少（< 3 可排名圈）或配速缺失时不标最快 / 最慢
eq(lapPaceMarks([lap(1, 300), lap(1, 320)]).map((m) => m.tag), ['', ''], 'min rankable laps');
eq(lapPaceMarks([lap(1, null), lap(1, null), lap(1, null)]).map((m) => m.tag), ['', '', ''], 'missing pace');

console.log('lapRows.check: OK');
