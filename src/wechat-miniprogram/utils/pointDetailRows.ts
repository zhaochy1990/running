// 积分明细页行纯逻辑（devops#894，消费已上线 #883 GET /api/users/me/points 契约）。
// amount 服务端已带符号（earn_checkin 正 / redeem 负，storage/points.go）；created_at
// 为 UTC RFC3339，用户可读时间按上海墙钟展示（timezone discipline）。
// 不引用 wx —— 供 utils/pointDetailRows.check.mts 在 node 下自检。

import type { PointTransaction } from '../services/points';
import { fmtShanghaiMdHm } from './format';

/** 交易类型 → 中文文案（expire/adjust V1 不产生，映射留位 #894 票面）。 */
const TYPE_LABELS: Record<string, string> = {
  earn_checkin: '签到所得',
  redeem: '兑换扣除',
  expire: '过期扣除',
  adjust: '积分调整',
};

/** 明细行视图模型。 */
export interface PointDetailRow {
  id: string;
  /** 类型文案。 */
  label: string;
  /** MM-DD HH:mm（上海墙钟）。 */
  time: string;
  /** 已带符号展示串：+10 / -120。 */
  delta: string;
  /** 正变动（粉色）true / 负变动（次要色）false。 */
  positive: boolean;
  /** redeem 副行「订单号 R-xxxx」；其余为空不渲染。 */
  ref: string;
}

/** 流水 → 明细行（未知类型兜底「积分变动」，防御后端新增枚举；remark 不进视图模型）。 */
export function toPointDetailRows(txs: PointTransaction[]): PointDetailRow[] {
  return txs.map((t) => ({
    id: t.id,
    label: TYPE_LABELS[t.type] || '积分变动',
    time: fmtShanghaiMdHm(t.created_at),
    delta: `${t.amount >= 0 ? '+' : ''}${t.amount}`,
    positive: t.amount >= 0,
    ref: t.type === 'redeem' && t.ref ? `订单号 R-${t.ref}` : '',
  }));
}
