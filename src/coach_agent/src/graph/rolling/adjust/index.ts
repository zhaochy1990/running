/**
 * 调整提案层（#858 PR-C）公开面：配方引擎（recipes）+ 批窗推导（window）+
 * 投影主入口 runAdjustProjection。检测层（detect/）产出 WeekDeviation，
 * 本层按原因生成「当前批次剩余周」的重生成提案；存储/同意流在 Go
 * （plan_adjustment 表 + 用户端点）与 worker（generate_adjustment job）。
 */

export type { AdjustOutcome, AdjustProjectionInput } from "./adjust.js";
export { runAdjustProjection } from "./adjust.js";
export type { AdjustRecipe } from "./recipes.js";
export { recipeFor } from "./recipes.js";
export type { AdjustWindowDecision, ExistingWeekRef } from "./window.js";
export { evaluateAdjustWindow, weekNumberOf } from "./window.js";
