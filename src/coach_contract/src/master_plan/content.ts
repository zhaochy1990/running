/**
 * master_plan.content 读写兼容层（devops#855，spec §2）。
 *
 * 判别子有两条：表的 `content_version` 列（Go 侧 1=markdown / 2=structured）
 * 与 content 内的 `schema` 字段。读路径以 `schema` 字段分发：
 * - 无该字段 = v2 存量行 → **原样**返回。读路径不重跑内容规则：存量是 8 月前
 *   老形态，形状完整性由 Go 写路径（validateStructuredPlanDoc +
 *   deepValidateStructuredContent）在写入时保证，读时再校验只会把老行挡在门外。
 * - `master-plan/v3` = 政策包 → 严格解析（v3 只由我们的写入侧产生）。
 * - 其它 schema 值 = 未知格式 → 抛错，不静默降级成 v2 视图（否则未来的 v4 行
 *   会被老代码读成残缺 v2）。
 *
 * shortcut: `content_version=3` 目前写不进去——DB CHECK 只允许 (1,2)
 * （src/migration/schema.sql、src/go/internal/storage/master_plan_models.go），
 * 且 Go 写路径恒写 2；放宽与落库实现一起做（spec §8 PR-5）。本文件先把判别子
 * 和读取侧定下来，写入侧接上时不改契约。
 */
import { MASTER_PLAN_V3_SCHEMA, type MasterPlanV3, MasterPlanV3Schema } from "./policy.js";

/** master_plan.content_version 取值（spec §2：v3 写路径写 3）。 */
export const MASTER_PLAN_CONTENT_VERSION = { v2: 2, v3: 3 } as const;
export type MasterPlanContentVersion = (typeof MASTER_PLAN_CONTENT_VERSION)[keyof typeof MASTER_PLAN_CONTENT_VERSION];

export type ParsedMasterPlanContent =
  | { contentVersion: typeof MASTER_PLAN_CONTENT_VERSION.v2; plan: Record<string, unknown> }
  | { contentVersion: typeof MASTER_PLAN_CONTENT_VERSION.v3; plan: MasterPlanV3 };

/** 按 content.schema 分发解析。入参须是已 JSON.parse 的对象（不接受原始 longtext）。 */
export function parseMasterPlanContent(raw: Record<string, unknown>): ParsedMasterPlanContent {
  const { schema } = raw;
  if (schema === MASTER_PLAN_V3_SCHEMA) {
    return { contentVersion: MASTER_PLAN_CONTENT_VERSION.v3, plan: MasterPlanV3Schema.parse(raw) };
  }
  if (schema !== undefined) {
    throw new Error(`unsupported master_plan content schema: ${String(schema)}`);
  }
  return { contentVersion: MASTER_PLAN_CONTENT_VERSION.v2, plan: raw };
}
