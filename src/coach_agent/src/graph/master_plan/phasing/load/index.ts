/**
 * master plan 载荷层 L3（devops#793，docs/coach_agent/daniels-l3-load.md）。
 *
 * 独立模块：输入=PhaseDivisionIntent（L2 产物）+ habitual 基线（R0-R5）+
 * 跑道参数 → 输出=周骨架（默认轨迹）+ 政策面产物。零 LLM。不含
 * kernel/weekly graph 接入（另票）、不含 L4 内容层、不含执行回路。
 *
 * 导出面=未来接入票的入口（buildLoadPlan + 基线件）；门与可达性件由
 * L2/L3 内部与测试走文件直连。
 */

export type { HabitualBaseline, SeriesWeek, WeeklySeries } from "./baseline.js";
export { buildWeeklySeries, habitualBaseline } from "./baseline.js";
export type {
  LoadBlock,
  LoadInput,
  LoadPlan,
  LoadRole,
  LoadWeek,
  MilestoneAlignment,
  RecoveryScenarioPolicy,
  StrengthPhasePolicy,
} from "./expand.js";
export { buildLoadPlan } from "./expand.js";
export type { LoadCheck } from "./gates.js";
