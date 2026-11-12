/**
 * adjustFlow.ts 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/adjustFlow.check.mts`。
 * 覆盖：六选项映射 / payload 解析容错 / choose 分流 / diff·窗口·审计文案 /
 * 每日一次门 / 轮询判定。不依赖小程序运行时。
 */
import {
  ADJUST_REASON_OPTIONS,
  buildAuditLine,
  buildDiffRows,
  buildWindowLabel,
  decideAfterChoose,
  decidePollResult,
  evidenceOf,
  fmtKmLoose,
  nextActionOfReason,
  parseAdjustPayload,
  shouldPopupToday,
} from './adjustFlow.ts';
import type { PlanAdjustment } from '../types/adjustment';

const row = (extra: Partial<PlanAdjustment> = {}): PlanAdjustment =>
  ({
    id: 'a1',
    master_plan_id: 'p1',
    event_week_start: '2026-11-02',
    reason: 'volume_unmet',
    status: 'pending',
    payload: null,
    question: '上周完成得不理想，主要是？',
    updated_at: '2026-11-09T08:00:00Z',
    ...extra,
  }) as PlanAdjustment;

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// —— 六选项：value 与后端 reason 枚举一一对应，含受伤 ——
eq(ADJUST_REASON_OPTIONS.length, 6, '六选项');
eq(
  ADJUST_REASON_OPTIONS.map((o) => o.value),
  ['pace_unmet', 'volume_unmet', 'no_time', 'injured', 'ran_other', 'over_delivered'],
  '六选项 value 枚举',
);
eq(ADJUST_REASON_OPTIONS[3].label, '受伤了', '受伤选项文案');

// —— Step1 按钮分流：受伤 → 伤病登记；其余 → 查看方案 ——
eq(nextActionOfReason('injured').kind, 'injury', '受伤走伤病流');
eq(nextActionOfReason('pace_unmet').kind, 'choose', '配速没达到走 choose');
eq(nextActionOfReason('over_delivered').kind, 'choose', '超量走 choose');

// —— payload 解析：null / 空 / 损坏 / 缺窗口都归 null ——
eq(parseAdjustPayload(null), null, 'payload null');
eq(parseAdjustPayload('not json'), null, 'payload 损坏 JSON');
eq(parseAdjustPayload('{"reason":"no_time"}'), null, 'payload 缺 window/diff');
const fullPayload = JSON.stringify({
  reason: 'no_time',
  window: { start_week: 5, end_week: 7 },
  weekly_docs: [{ week_name: '2026-11-02_11-08' }],
  diff: [{ week: 5, old_km: 60, new_km: 48 }],
  evidence: '上周只跑了 1 次 12km',
  audit_summary: { pass: 3, warn: 1, fail: 0 },
});
const parsed = parseAdjustPayload(fullPayload);
if (parsed == null) throw new Error('完整 payload 应解析成功');
eq(parsed.window.start_week, 5, 'payload window 透传');
eq(parsed.evidence, '上周只跑了 1 次 12km', 'payload evidence 透传');

// —— Step1 副行证据：从 adjustment.payload 提取；无 payload 留空 ——
eq(evidenceOf(row({ payload: fullPayload })), '上周只跑了 1 次 12km', '副行证据提取');
eq(evidenceOf(row()), '', '无 payload 副行为空');

// —— choose 分流：payload 恢复 → 出方案；清空 → 重生成 ——
eq(decideAfterChoose('no_time', row({ payload: fullPayload })).kind, 'show-plan', '同因 payload 出方案');
const regen = decideAfterChoose('no_time', row({ reason: 'no_time', payload: null }));
if (regen.kind !== 'regenerate') throw new Error('payload 清空应走重生成');
eq(regen.reason, 'no_time', '重生成带用户改选原因');

// —— 轮询判定：行在且 payload 恢复 → ready；行消失 → 继续等（超时由次数封顶） ——
eq(decidePollResult(row({ payload: fullPayload })), 'ready', '轮询 payload 恢复');
eq(decidePollResult(row()), 'continue', '轮询 payload 仍空');
eq(decidePollResult(null), 'continue', '轮询行消失继续等');

// —— diff 行：按周排序 + 百分比方向 ——
const diffRows = buildDiffRows([
  { week: 6, old_km: 60, new_km: 60 },
  { week: 5, old_km: 50, new_km: 40 },
  { week: 7, old_km: 55.5, new_km: 61 },
]);
eq(diffRows.length, 3, 'diff 行数');
eq(diffRows[0].weekLabel, 'W05', 'diff 排序');
eq(diffRows[0].deltaText, '-20%', '降量百分比');
eq(diffRows[0].isDown, true, '降量标记');
eq(diffRows[1].deltaText, '持平', '持平文案');
eq(diffRows[1].isDown, false, '持平非降量');
eq(diffRows[2].deltaText, '+10%', '增量百分比（四舍五入）');
eq(diffRows[2].newKm, '61', '整数 km');
eq(diffRows[2].oldKm, '55.5', '一位小数 km');
eq(diffRows[0].oldKm, '50', '整数 km 旧值');
eq(fmtKmLoose(Number.NaN), '—', '非法 km 兜底');

// —— 窗口 / 审计文案 ——
eq(buildWindowLabel({ start_week: 5, end_week: 7 }), '调整窗口 3 周（W05–W07）', '窗口文案');
eq(buildWindowLabel({ start_week: 9, end_week: 9 }), '调整窗口 1 周（W09–W09）', '单周窗口');
eq(buildAuditLine({ pass: 3, warn: 1, fail: 0 }), '方案审计：3 项通过 · 1 项提醒 · 0 项未过', '审计行');
eq(buildAuditLine(null), '', '审计缺失留空');

// —— 每日一次门（上海日口径的日期串由调用方传入） ——
eq(shouldPopupToday(null, '2026-11-10'), true, '从未弹过 → 弹');
eq(shouldPopupToday('2026-11-09', '2026-11-10'), true, '昨天弹过 → 今天再弹');
eq(shouldPopupToday('2026-11-10', '2026-11-10'), false, '今天已弹 → 不弹');
eq(shouldPopupToday('', '2026-11-10'), true, '空串视为未弹过');

console.log('adjustFlow.check: all passed');
