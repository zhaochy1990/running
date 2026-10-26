/**
 * master plan 阶段划分意图层（devops#782，docs/coach_agent/daniels.md §1-§2）。
 *
 * 独立可测试模块：证据 → 判断（deepseek-flash）→ 确定性结构门 → T 表兜底，
 * 输出 PhaseDivisionIntent。不含 kernel/graph 接入（另票）、不含载荷层块机制
 * （另票）、不含意图产物持久化 schema（接入票再定）。
 */

export type { PhasingIntentInput } from "./doctrine.js";
export { buildIntentMessages, buildIntentPayload, PHASING_DOCTRINE } from "./doctrine.js";
export type { MonthlyFocus, PhaseEvidence, PhasingActivityInput, PhasingGoalInput } from "./evidence.js";
export { buildPhaseEvidence, PhaseEvidenceSchema } from "./evidence.js";
export { tableFallback } from "./fallback.js";
export type { GateCheck } from "./gates.js";
export { gateViolations, peakVolumeCapKm, validatePhaseIntent } from "./gates.js";
export type { PhaseDivisionOutcome, PhasingModel } from "./generate.js";
export { createPhasingModel, generatePhaseDivisionIntent } from "./generate.js";
export type { PhaseCanonical, PhaseDivisionIntent } from "./intent.js";
export {
  DEFAULT_PRIMARY_GOAL,
  EXPECTED_BLOCK_MODE,
  MIN_PHASE_WEEKS,
  PHASE_BLOCK_MODE,
  PHASE_CANONICAL,
  PHASE_DISPLAY_NAME,
  PHASE_ORDER,
  PHASE_PRIMARY_GOAL,
  PhaseDivisionIntentSchema,
} from "./intent.js";
