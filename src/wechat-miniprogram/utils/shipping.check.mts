// shipping.ts 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/shipping.check.mts`。
// 覆盖运费口径镜像（jzsh_fee × 省份 / nationwide_free / 未知策略 / 裸省名）与
// 分→元展示格式化（devops#905 AC：江浙沪地址选全国包邮/江浙沪商品都显示包邮）。
import { formatFen, shippingFeeFen } from './shipping.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// ── shippingFeeFen：jzsh_fee 只对江浙沪外收运费 ──
eq(shippingFeeFen('jzsh_fee', 800, '山东省'), 800, 'jzsh_fee charges outside block');
eq(shippingFeeFen('jzsh_fee', 800, '上海市'), 0, 'shanghai free');
eq(shippingFeeFen('jzsh_fee', 800, '江苏省'), 0, 'jiangsu free');
eq(shippingFeeFen('jzsh_fee', 800, '浙江省'), 0, 'zhejiang free');
eq(shippingFeeFen('jzsh_fee', 800, '上海'), 0, 'bare province name free (admin-seeded)');
eq(shippingFeeFen('jzsh_fee', 800, '北京'), 800, 'bare name outside block charged');

// ── nationwide_free / 未知策略 / 旧后端缺字段 → 一律免运 ──
eq(shippingFeeFen('nationwide_free', 800, '山东省'), 0, 'nationwide_free never charges');
eq(shippingFeeFen(undefined, 800, '山东省'), 0, 'missing policy (old backend) free');
eq(shippingFeeFen('whatever', 800, '山东省'), 0, 'unknown policy free (server enum fallback)');
eq(shippingFeeFen('jzsh_fee', 0, '山东省'), 0, 'zero fee stays zero');

// ── formatFen：分 → 元，去尾零 ──
eq(formatFen(800), '8', 'whole yuan');
eq(formatFen(850), '8.5', 'one decimal');
eq(formatFen(808), '8.08', 'two decimals kept');
eq(formatFen(20), '0.2', 'sub-yuan trims');
eq(formatFen(0), '0', 'zero fee');
eq(formatFen(1000), '10', 'three digits');

console.log('shipping.check: all assertions passed');
