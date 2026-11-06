// pointDetailRows.ts 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/pointDetailRows.check.mts`。
// 覆盖类型文案映射（expire/adjust 留位 + 未知兜底）、带符号分值与颜色位、redeem 订单号副行、
// UTC → 上海墙钟时间（#883 created_at 为 UTC RFC3339）。
import { toPointDetailRows } from './pointDetailRows.ts';
import type { PointTransaction } from '../services/points.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

const tx = (over: Partial<PointTransaction>): PointTransaction => ({
  id: 'tx-1',
  type: 'earn_checkin',
  amount: 10,
  ref: '',
  remark: null,
  created_at: '2026-11-05T16:02:00Z',
  ...over,
});

// ── type → 文案映射（expire/adjust 留位）──
eq(toPointDetailRows([tx({})])[0].label, '签到所得', 'earn_checkin label');
eq(toPointDetailRows([tx({ type: 'redeem' })])[0].label, '兑换扣除', 'redeem label');
eq(toPointDetailRows([tx({ type: 'expire' })])[0].label, '过期扣除', 'expire reserved slot');
eq(toPointDetailRows([tx({ type: 'adjust' })])[0].label, '积分调整', 'adjust reserved slot');
eq(toPointDetailRows([tx({ type: 'future_thing' })])[0].label, '积分变动', 'unknown type falls back');

// ── 带符号分值 + 颜色位（amount 服务端已定号）──
const plus = toPointDetailRows([tx({ amount: 11 })])[0];
eq(plus.delta, '+11', 'positive gets + prefix');
eq(plus.positive, true, 'positive → pink');
const minus = toPointDetailRows([tx({ type: 'redeem', amount: -120 })])[0];
eq(minus.delta, '-120', 'negative already signed');
eq(minus.positive, false, 'negative → secondary');

// ── redeem 订单号副行；其余类型/空 ref 不渲染 ──
eq(toPointDetailRows([tx({ type: 'redeem', ref: '9f2c' })])[0].ref, '订单号 R-9f2c', 'redeem ref subrow');
eq(toPointDetailRows([tx({ ref: '9f2c' })])[0].ref, '', 'non-redeem ref not rendered');
eq(toPointDetailRows([tx({ type: 'redeem', ref: '' })])[0].ref, '', 'empty ref not rendered');

// ── UTC → 上海墙钟：UTC 16:02 → 上海次日 00:02（跨日）──
eq(toPointDetailRows([tx({})])[0].time, '11-06 00:02', 'utc → shanghai wall clock');
// remark 可空不渲染：视图模型不含 remark，有值也不影响行
eq(toPointDetailRows([tx({ remark: '运营调整' })]).length, 1, 'remark ignored in view model');

console.log('pointDetailRows.check: all assertions passed');
