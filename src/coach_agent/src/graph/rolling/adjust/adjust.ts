/**
 * 调整投影主入口（#858 PR-C 上半）：偏差周 → 按用户原因重生成**当前批次剩余
 * 周**的调整提案（weeklyDocs + diff + audit + evidence），**同意才应用**——
 * 落库归 Go batch-apply（plan_adjustment accept 端点），本层纯函数无存储。
 *
 * 语义（票面定稿）：
 * - 窗口=事件周+1 →（当前周所在块末 ∩ lastGeneratedWeek ∩ 已落库周）——只改
 *   已可见的剩余周，不出新周（边界出新块归 generate_rolling_block）；窗口含
 *   当前周时追赶冻结生效（date<明天删会话）。
 * - 配方参数（recipeFor）：vdotShift 投影带偏移 / qualityCap 质量课配额 /
 *   kmDerateFirstWeek 首周降载 / guidance 注入 L4a 的周调整指令。
 * - injured 不走本引擎（PR-D 伤病模式）：recipeFor 抛错，调用方转 permanent
 *   error——数据只预判，用户真选受伤时由伤病流接管。
 * - infeasible（L3 门挂）与 no_op（窗口空）语义照 rolling。
 */
import type { DanielsAudit, WeeklyPlan } from "@stride/contract";
import type { AskReason, WeekDeviation } from "../detect/detector.js";
import type { RollingDeps, RollingProjectionInput } from "../projection.js";
import { runProjectionCore, type CoreOutcome } from "../projection.js";
import { recipeFor } from "./recipes.js";
import type { ExistingWeekRef } from "./window.js";

export type AdjustOutcome =
  | {
      decision: "completed";
      reason: AskReason;
      window: { startWeek: number; endWeek: number };
      /** 重生成的剩余周（含滚动扩展字段，完整 weekly-plan/v1 文档）。 */
      weeklyDocs: WeeklyPlan[];
      /** 新周文档 target km vs 现 weekly 行的对照。 */
      diff: Array<{ week: number; oldKm: number; newKm: number }>;
      audit: DanielsAudit;
      /** 透传 detector evidence（追问弹窗直接展示）。 */
      evidence: string;
    }
  | { decision: "no_op"; reason: string }
  | { decision: "infeasible"; reason: string; failedChecks: Array<{ id: string; detail: string }> };

export interface AdjustProjectionInput extends Pick<RollingProjectionInput, "userId" | "master" | "asOf"> {
  /** 检测产物（事件周取 deviation.weekStart）。 */
  deviation: WeekDeviation;
  /** 调用方已解析的最终原因（预判或用户改选；injured 在此拦截报错）。 */
  reason: AskReason;
  /** 现有 weekly 行（diff 基准 + 窗口推导：只改已可见周）。 */
  existingWeeks: ExistingWeekRef[];
}

/**
 * 调整投影主入口：recipeFor 先行（injured→抛错给调用方，确定性失败不进
 * L1/L3），随后复用共享投影内核（新鲜 L1 → L3 重展开 → 调整批窗 → 配方覆写
 * 的 L4 批生成 → 审计 → 周课文档 + diff）。
 */
export async function runAdjustProjection(deps: RollingDeps, input: AdjustProjectionInput): Promise<AdjustOutcome> {
  const recipe = recipeFor(input.reason); // injured/未知原因在此抛错（调用方转 permanent error）
  const core: CoreOutcome = await runProjectionCore(
    deps,
    { userId: input.userId, master: input.master, asOf: input.asOf },
    { eventWeekStart: input.deviation.weekStart, recipe, existingWeeks: input.existingWeeks },
  );
  if (core.decision !== "completed") return core;
  return {
    decision: "completed",
    reason: input.reason,
    window: { startWeek: core.window.startWeek, endWeek: core.window.endWeek },
    weeklyDocs: core.weeklyDocs,
    diff: core.diff ?? [],
    audit: core.audit,
    evidence: input.deviation.evidence,
  };
}
