import { z } from "zod/v4";

/**
 * 阶段划分意图契约（devops#782，daniels.md §1/§2.2）。
 *
 * canonical 五值对齐 Daniels' Running Formula：recovery 是本体系对丹尼尔斯的
 * 正式化补充；taper 不是阶段，是 final_quality 的必填属性 taper_weeks（结构
 * 参数归意图层，削减深度归载荷层）。旧枚举 base/speed/build/marathon 弃用。
 */
export const PHASE_CANONICAL = z.enum(["recovery", "foundation", "early_quality", "transition_quality", "final_quality"]);
export type PhaseCanonical = z.infer<typeof PHASE_CANONICAL>;

/** 阶段能力重点（顺序与 canonical 对齐丹尼尔斯 Phase 1-4 职能）。 */
export const PHASE_PRIMARY_GOAL = z.enum(["recovery", "aerobic_base", "speed", "threshold", "race_specificity"]);

/** 块形状（daniels.md §3.4：阶段目标决定块模式；载荷层按此物化）。 */
export const PHASE_BLOCK_MODE = z.enum(["light", "progressive", "progressive_quality", "plateau"]);

export const PhaseDivisionIntentSchema = z.object({
  phases: z
    .array(
      z.object({
        canonical: PHASE_CANONICAL,
        name: z.string().min(1),
        start_week: z.number().int().min(1),
        end_week: z.number().int().min(1),
        primary_goal: PHASE_PRIMARY_GOAL,
        training_goal: z.string().min(1),
        block_mode: PHASE_BLOCK_MODE,
        rationale: z.string().min(1),
      }),
    )
    .min(1)
    .max(6),
  /** final_quality 内的减量周数（削减深度归载荷层）。 */
  taper_weeks: z.number().int().min(1).max(3),
  /** 阶段出口里程碑：final_quality 之外每阶段至少 1 条，绑可观察信号。 */
  milestones: z
    .array(z.object({ phase: z.string().min(1), signal: z.string().min(1), criterion: z.string().min(1) }))
    .min(1)
    .max(8),
  /** 阶段间 gate 2-3 条，供执行回路在块边界选择回补场景。 */
  gates: z
    .array(
      z.object({
        phase: z.string().min(1),
        signal: z.string().min(1),
        criterion: z.string().min(1),
        action_if_missed: z.string().min(1),
      }),
    )
    .min(2)
    .max(3),
  /** 每阶段周量护栏，由证据推导（I8 门校验），非 LLM 自由发明。 */
  volume_bands: z
    .array(z.object({ phase: z.string().min(1), weekly_km_min: z.number().min(0), weekly_km_max: z.number().positive() }))
    .min(1)
    .max(6),
});
export type PhaseDivisionIntent = z.infer<typeof PhaseDivisionIntentSchema>;

/** canonical → 显示名（daniels.md §1 表）。 */
export const PHASE_DISPLAY_NAME: Record<PhaseCanonical, string> = {
  recovery: "恢复期",
  foundation: "第一阶段·基础期",
  early_quality: "第二阶段·早期质量期",
  transition_quality: "第三阶段·过渡质量期",
  final_quality: "第四阶段·最终质量期",
};

/** canonical → 块模式（daniels.md §3.4；I9 门按此校验）。 */
export const EXPECTED_BLOCK_MODE: Record<PhaseCanonical, z.infer<typeof PHASE_BLOCK_MODE>> = {
  recovery: "light",
  foundation: "progressive",
  early_quality: "progressive_quality",
  transition_quality: "progressive_quality",
  final_quality: "plateau",
};

/** canonical → 能力重点缺省（T 兜底用；判断层 LLM 可给出不同但同目的的组合）。 */
export const DEFAULT_PRIMARY_GOAL: Record<PhaseCanonical, z.infer<typeof PHASE_PRIMARY_GOAL>> = {
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

/** 顺序律基准（I2）：可坍缩（跳过）不可倒置、不重复。 */
export const PHASE_ORDER: readonly PhaseCanonical[] = ["recovery", "foundation", "early_quality", "transition_quality", "final_quality"];
