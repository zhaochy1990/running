import { PHASE_CANONICAL, type PhaseBlockMode, type PhaseCanonical, type PhasePrimaryGoal } from "@stride/contract";

export type { PhaseBlockMode, PhaseCanonical, PhaseDivisionIntent, PhasePrimaryGoal } from "@stride/contract";

/**
 * 阶段划分意图的**运行时**消费者（devops#782，daniels.md §1/§2.2）。
 *
 * 契约本体（PhaseDivisionIntentSchema + 三个枚举 + 类型）在
 * `@stride/contract`——政策包 v3 的 policy 段要与落库 schema 单源
 * （devops#855）。这里只保留 L2 判断层自己的显示名/块模式/最小周期等
 * 口径表与匹配工具，并原样转出契约，既有 import 不用改。
 */
export {
  PHASE_BLOCK_MODE,
  PHASE_CANONICAL,
  PHASE_PRIMARY_GOAL,
  PhaseDivisionIntentSchema,
} from "@stride/contract";

/** canonical → 显示名（daniels.md §1 表）。 */
export const PHASE_DISPLAY_NAME: Record<PhaseCanonical, string> = {
  recovery: "恢复期",
  foundation: "第一阶段·基础期",
  early_quality: "第二阶段·早期质量期",
  transition_quality: "第三阶段·过渡质量期",
  final_quality: "第四阶段·最终质量期",
};

/** canonical → 块模式（daniels.md §3.4；I9 门按此校验）。 */
export const EXPECTED_BLOCK_MODE: Record<PhaseCanonical, PhaseBlockMode> = {
  recovery: "light",
  foundation: "progressive",
  early_quality: "progressive_quality",
  transition_quality: "progressive_quality",
  final_quality: "plateau",
};

/** canonical → 能力重点缺省（T 兜底用；判断层 LLM 可给出不同但同目的的组合）。 */
export const DEFAULT_PRIMARY_GOAL: Record<PhaseCanonical, PhasePrimaryGoal> = {
  recovery: "recovery",
  foundation: "aerobic_base",
  early_quality: "speed",
  transition_quality: "threshold",
  final_quality: "race_specificity",
};

/** 最小有效周期（daniels.md §2.4）：短于该周数的阶段不设立。 */
export const MIN_PHASE_WEEKS: Record<PhaseCanonical, number> = {
  recovery: 1,
  foundation: 2,
  early_quality: 2,
  transition_quality: 2,
  final_quality: 3,
};

/** 顺序律基准（I2）：可坍缩（跳过）不可倒置、不重复；取契约枚举声明序，不手抄五值（#855 单源）。 */
export const PHASE_ORDER: readonly PhaseCanonical[] = PHASE_CANONICAL.options;

/**
 * phase 引用字符串（milestones/gates/volume_bands 的 phase 字段）与阶段行匹配
 * （宽松三子句）。L2 门与 L3 载荷层共用；查带必须用真实阶段行——引用常带
 * 中文显示名（如「第一阶段·基础期（W3-W8）」），拿 canonical 造的假行永远
 * 匹配不上（devops#793 spike 实测陷阱）。
 */
export function phaseRefMatches(phase: { canonical: string; name: string }, ref: string): boolean {
  return ref.includes(phase.canonical) || ref === phase.name || phase.name.includes(ref);
}
