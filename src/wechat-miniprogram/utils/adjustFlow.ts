// 调整弹窗纯逻辑（#858 PR-E）—— 状态机/文案/视图模型全部抽纯函数，组件只做
// 事件接线；node 自检见 utils/adjustFlow.check.mts（不依赖小程序运行时）。

import type { AdjustProposalPayload, AdjustReason, PlanAdjustment } from '../types/adjustment';

/** 追问六选项（票面文案），value 即后端 reason 枚举。 */
export interface AdjustReasonOption {
  value: AdjustReason;
  label: string;
}

export const ADJUST_REASON_OPTIONS: ReadonlyArray<AdjustReasonOption> = [
  { value: 'pace_unmet', label: '配速没达到' },
  { value: 'volume_unmet', label: '量没练完' },
  { value: 'no_time', label: '没时间跑' },
  { value: 'injured', label: '受伤了' },
  { value: 'ran_other', label: '跑了别的' },
  { value: 'over_delivered', label: '完成超量' },
];

/** 弹窗主状态机：ask 追问 →（同因直接出 / 异因 loading 轮询）→ plan 方案 → done。 */
export type AdjustDialogStep = 'ask' | 'plan' | 'loading' | 'timeout';

/** 安全解析 payload JSON；null / 损坏 / 缺关键字段一律归 null（进轮询态）。 */
export function parseAdjustPayload(payloadJson: string | null): AdjustProposalPayload | null {
  if (!payloadJson) return null;
  try {
    const v = JSON.parse(payloadJson) as Partial<AdjustProposalPayload>;
    if (!v || typeof v !== 'object' || !v.window || !Array.isArray(v.diff)) return null;
    return v as AdjustProposalPayload;
  } catch {
    return null;
  }
}

/** Step1 底部按钮分流：受伤走伤病登记（不走 choose）；其余查看方案。 */
export function nextActionOfReason(
  reason: AdjustReason,
): { kind: 'injury' } | { kind: 'choose' } {
  return reason === 'injured' ? { kind: 'injury' } : { kind: 'choose' };
}

/** Step1 副行证据：payload 里有 detector 证据优先，无 payload（重生成中）留空。 */
export function evidenceOf(adjustment: PlanAdjustment): string {
  return parseAdjustPayload(adjustment.payload)?.evidence ?? '';
}

/** 整数无小数、否则 1 位小数（与训练计划页 fmtKm 口径一致）。 */
export function fmtKmLoose(v: number): string {
  return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : '—';
}

/** Step2 diff 表行：W周号 + 旧 km → 新 km（含增减方向文案）。 */
export interface AdjustDiffRowVM {
  key: string;
  weekLabel: string;
  oldKm: string;
  newKm: string;
  /** −12% / +8% / 持平（新旧行 km 缺失时为空串） */
  deltaText: string;
  /** 降量（新<旧）用强调色，增量为常规色 */
  isDown: boolean;
}

export function buildDiffRows(diff: Array<{ week: number; old_km: number; new_km: number }>): AdjustDiffRowVM[] {
  return [...diff]
    .sort((a, b) => a.week - b.week)
    .map((row, i) => {
      let deltaText = '';
      let isDown = false;
      if (row.old_km > 0) {
        const pct = Math.round(((row.new_km - row.old_km) / row.old_km) * 100);
        isDown = pct < 0;
        deltaText = pct === 0 ? '持平' : `${pct > 0 ? '+' : ''}${pct}%`;
      }
      return {
        key: `d${i}`,
        weekLabel: `W${String(row.week).padStart(2, '0')}`,
        oldKm: fmtKmLoose(row.old_km),
        newKm: fmtKmLoose(row.new_km),
        deltaText,
        isDown,
      };
    });
}

/** Step2 窗口行：「调整窗口 3 周（W05–W07）」。 */
export function buildWindowLabel(window: { start_week: number; end_week: number }): string {
  const weeks = Math.max(1, window.end_week - window.start_week + 1);
  const w = (n: number) => `W${String(n).padStart(2, '0')}`;
  return `调整窗口 ${weeks} 周（${w(window.start_week)}–${w(window.end_week)}）`;
}

/** Step2 审计一行摘要：「方案审计：3 项通过 · 1 项提醒 · 0 项未过」。 */
export function buildAuditLine(summary: { pass: number; warn: number; fail: number } | undefined | null): string {
  if (!summary) return '';
  return `方案审计：${summary.pass} 项通过 · ${summary.warn} 项提醒 · ${summary.fail} 项未过`;
}

/** 轮询节奏常量（票面：8s 间隔、≤90s；总预算内最多 11 次尝试）。 */
export const ADJUST_POLL_INTERVAL_MS = 8000;
export const ADJUST_POLL_MAX_ATTEMPTS = 11;

/**
 * 每日一次弹窗门（上海日口径）：上次弹出日 != 今天 → 该弹。
 * lastDay 为空（从未弹过）同样返回 true；日期串非法不拦（宁可多弹一次）。
 */
export function shouldPopupToday(lastDay: string | null | undefined, todayYmd: string): boolean {
  if (!lastDay) return true;
  return lastDay !== todayYmd;
}

/**
 * choose 后的动作决策（纯）：payload 已带方案 → 直接出 Step2；
 * payload 为 null（异因 202 / 同因重开行）→ 换因重生成（enqueue + 轮询）。
 */
export function decideAfterChoose(
  reason: AdjustReason,
  updated: PlanAdjustment,
): { kind: 'show-plan' } | { kind: 'regenerate'; reason: Exclude<AdjustReason, 'injured'> } {
  if (updated.payload != null) return { kind: 'show-plan' };
  return { kind: 'regenerate', reason: reason as Exclude<AdjustReason, 'injured'> };
}

/** 轮询到的 pending 行 → 下一步：payload 恢复出方案；行消失（被处理/竞态）算超时收尾。 */
export function decidePollResult(pending: PlanAdjustment | null): 'ready' | 'continue' {
  return pending != null && pending.payload != null ? 'ready' : 'continue';
}
