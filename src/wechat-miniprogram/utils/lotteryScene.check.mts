/**
 * lotteryScene 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/lotteryScene.check.mts`
 * （或 `npm test`）。覆盖双入口解析（直参 / scene / 坏编码 / 非法 ID）与时间窗展示。
 */
import { parseLotteryEntry, lotteryPhaseMeta, lotteryWindow } from './lotteryScene.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function deepEq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

// ---- parseLotteryEntry：query 直参优先 ----
deepEq(parseLotteryEntry({ a: '3', s: 'booth-7' }), { a: '3', s: 'booth-7' }, '直参 a+s');
deepEq(parseLotteryEntry({ a: '3' }), { a: '3', s: '' }, '直参 a 无 s');
eq(parseLotteryEntry({ a: ' 3 ' })?.a, '3', '直参去空白');

// ---- scene 直达（易拉宝码主路径）----
// wxacode scene 落地时框架会做一次 URL 解码，onLoad 收到的常是已解码的 `a=xx&s=yy`；
// 也兼容仍带百分号编码的形态（decodeURIComponent 再解一次）。
deepEq(parseLotteryEntry({ scene: 'a=12&s=k1' }), { a: '12', s: 'k1' }, 'scene 已解码');
deepEq(parseLotteryEntry({ scene: 'a%3D12%26s%3Dk1' }), { a: '12', s: 'k1' }, 'scene 百分号编码');
deepEq(parseLotteryEntry({ scene: 'a=12' }), { a: '12', s: '' }, 'scene 无点位号');
deepEq(parseLotteryEntry({ scene: 's=k1&a=12' }), { a: '12', s: 'k1' }, 'scene 键序无关');
deepEq(parseLotteryEntry({ scene: 'a=12&s=' }), { a: '12', s: '' }, 'scene 空点位号');
deepEq(parseLotteryEntry({ scene: 'a=12&x=9' }), { a: '12', s: '' }, 'scene 未知键忽略');

// ---- 直参与 scene 同时带时直参优先 ----
deepEq(parseLotteryEntry({ a: '3', scene: 'a=99&s=k1' }), { a: '3', s: '' }, '直参优先');

// ---- 非法 / 缺参 → null（notfound 空态）----
eq(parseLotteryEntry({}), null, '空参数');
eq(parseLotteryEntry({ s: 'k1' }), null, '只有点位号');
eq(parseLotteryEntry({ scene: '' }), null, '空 scene');
eq(parseLotteryEntry({ scene: 'foo' }), null, 'scene 非查询串');
eq(parseLotteryEntry({ a: 'abc' }), null, '非数字活动 ID');
eq(parseLotteryEntry({ a: '1'.repeat(16) }), null, '活动 ID 超 15 位');
eq(parseLotteryEntry({ a: '3;drop' }), null, '活动 ID 带注入字符');
eq(parseLotteryEntry({ a: '3.5' }), null, '活动 ID 带小数点');
// 坏百分号编码：decode 抛错回落原串，含 % 的值过不了数字 ID 校验 → null
// （catch 只是 coach-share 同款容错，不产生「部分解码」结果）。
eq(parseLotteryEntry({ scene: 'a=%zz1' }), null, 'scene 坏编码回落原串仍非法');

// ---- 时间窗展示（上海墙钟，跨日 / 跨年场景看字符串形状即可）----
eq(lotteryWindow('2026-11-10T10:00:00Z', '2026-11-20T14:00:00Z'), '11-10 18:00 ~ 11-20 22:00', '时间窗上海墙钟');

// ---- 状态章 + 提示行 ----
deepEq(
  lotteryPhaseMeta('not_started', '2026-11-10T10:00:00Z', '2026-11-20T14:00:00Z'),
  { label: '未开始', hint: '11-10 18:00 开始' },
  '未开始提示行',
);
deepEq(
  lotteryPhaseMeta('active', '2026-11-10T10:00:00Z', '2026-11-20T14:00:00Z'),
  { label: '进行中', hint: '11-10 18:00 ~ 11-20 22:00' },
  '进行中提示行',
);
deepEq(
  lotteryPhaseMeta('ended', '2026-11-10T10:00:00Z', '2026-11-20T14:00:00Z'),
  { label: '已结束', hint: '11-10 18:00 ~ 11-20 22:00' },
  '已结束提示行',
);

console.log('lotteryScene.check: all pass');
