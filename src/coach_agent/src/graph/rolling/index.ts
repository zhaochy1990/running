/**
 * 滚动出课内核（#858 PR-A Round 1）公开面：批窗计算 / 周课文档构造 / 主入口
 * runRollingProjection + master 产物适配器 fromMasterArtifact；#858 PR-C 增补
 * 调整提案层（adjust/：配方引擎 + 调整批窗 + runAdjustProjection）。
 *
 * 契约侧输入类型（RollingMasterInput）与 weekly-plan/v1 扩展字段在
 * `@stride/contract`（weekly_plan/rolling.ts + schema.ts）。
 */

export * from "./adjust/index.js";
export type {
  CoreCompleted,
  CoreOutcome,
  MasterPlanArtifact,
  ProjectionAdjustOverrides,
  RollingDeps,
  RollingOutcome,
  RollingProjectionInput,
} from "./projection.js";
export { diffOfWeeks, fromMasterArtifact, runProjectionCore, runRollingProjection } from "./projection.js";
export { fromStoredContent, storedWeeklyDocOf } from "./storedContent.js";
export type { WeeklyDocsInput } from "./weeklyDocs.js";
export { buildWeeklyDocs, freezePastSessions } from "./weeklyDocs.js";
export type { RollingWindow } from "./window.js";
export { computeRollingWindow, currentWeekOf, evaluateRollingWindow } from "./window.js";
