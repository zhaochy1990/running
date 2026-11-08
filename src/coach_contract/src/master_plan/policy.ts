/**
 * 政策包 v3（devops#855，spec: docs/coach_agent/803-integration-spec.md §2）。
 *
 * master_plan.content v3 = 政策包（L2 阶段意图 + L3 载荷骨架 + 生成时点锚 +
 * 丹尼尔斯审计）+ v2 课表字段全保留（首期快照）。本文件是这四段的 zod 单源：
 * 生成侧（kernel/writer）与读取侧（兼容层）都从这里取，不各自声明一份。
 *
 * policy/skeleton 的运行时生产者仍是 `coach_agent` 的 phasing 模块，那边只
 * 反向 re-export 这里的 schema/type——契约只能在 contract 包定型（本包不依赖
 * coach_agent）。
 */
import { z } from "zod/v4";
import { DaySchema, MasterPlanSchema } from "./schemas.js";

// ── policy：L2 阶段划分意图（daniels.md §1/§2.2）──────────────────────────────
//
// canonical 五值对齐 Daniels' Running Formula：recovery 是本体系对丹尼尔斯的
// 正式化补充；taper 不是阶段，是 final_quality 的必填属性 taper_weeks（结构
// 参数归意图层，削减深度归载荷层）。旧枚举 base/speed/build/marathon 弃用。

export const PHASE_CANONICAL = z.enum(["recovery", "foundation", "early_quality", "transition_quality", "final_quality"]);
export type PhaseCanonical = z.infer<typeof PHASE_CANONICAL>;

/** 阶段能力重点（顺序与 canonical 对齐丹尼尔斯 Phase 1-4 职能）。 */
export const PHASE_PRIMARY_GOAL = z.enum(["recovery", "aerobic_base", "speed", "threshold", "race_specificity"]);
export type PhasePrimaryGoal = z.infer<typeof PHASE_PRIMARY_GOAL>;

/** 块形状（daniels.md §3.4：阶段目标决定块模式；载荷层按此物化）。 */
export const PHASE_BLOCK_MODE = z.enum(["light", "progressive", "progressive_quality", "plateau"]);
export type PhaseBlockMode = z.infer<typeof PHASE_BLOCK_MODE>;

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

// ── skeleton：L3 载荷层产物（daniels-l3-load.md §3）───────────────────────────

export const LoadRoleSchema = z.enum(["progress", "absorb", "taper", "race"]);
export type LoadRole = z.infer<typeof LoadRoleSchema>;

/** 周骨架行（默认轨迹；spec §3 产出物 1）。 */
export const LoadWeekSchema = z.object({
  week: z.number().int().min(1),
  canonical: PHASE_CANONICAL,
  block: z.number().int().min(1),
  role: LoadRoleSchema,
  km: z.number().nonnegative(),
  /** 长跑（km）；赛周 null（比赛本身不算训练长跑）。 */
  lr: z.number().nonnegative().nullable(),
  /** 质量课配额。 */
  q: z.number().int().nonnegative(),
});
export type LoadWeek = z.infer<typeof LoadWeekSchema>;

/** 块结构标记（spec §3 产出物 2）：3+1 边界与块角色，R2 校准挂点。 */
export const LoadBlockSchema = z.object({
  block: z.number().int().min(1),
  canonical: PHASE_CANONICAL,
  start_week: z.number().int().min(1),
  end_week: z.number().int().min(1),
  /** 块内吸收周（3+1 的「1」；空=纯相位块）。 */
  absorb_weeks: z.array(z.number().int().min(1)),
  /** phase_start=相位切换开块；absorb_cut=吸收周自身开新块。 */
  boundary: z.enum(["phase_start", "absorb_cut"]),
});
export type LoadBlock = z.infer<typeof LoadBlockSchema>;

/** 回补策略场景（spec §3 产出物 3，政策面数据，R2 直接读取）。 */
export const RecoveryScenarioPolicySchema = z.object({
  id: z.enum(["normal", "fatigue", "overshoot"]),
  trigger: z.string().min(1),
  action: z.string().min(1),
  depth: z.string().min(1),
});
export type RecoveryScenarioPolicy = z.infer<typeof RecoveryScenarioPolicySchema>;

/** 力量指导 policy（spec §3 产出物 4，阶段级方向规则；实质课表在 weekly plan）。 */
export const StrengthPhasePolicySchema = z.object({
  canonical: PHASE_CANONICAL,
  strength_focus: z.string().min(1),
  quality_family: z.string().min(1),
  strides_note: z.string().min(1),
});
export type StrengthPhasePolicy = z.infer<typeof StrengthPhasePolicySchema>;

/** 边界检查结果（spec §3 产出物 5a，六条验收门）。 */
export const LoadCheckSchema = z.object({
  id: z.string().min(1),
  pass: z.boolean(),
  detail: z.string(),
});
export type LoadCheck = z.infer<typeof LoadCheckSchema>;

/** 里程碑对齐（spec §3 产出物 5b）：L2 出口里程碑落到周序号。 */
export const MilestoneAlignmentSchema = z.object({
  phase: z.string().min(1),
  signal: z.string().min(1),
  criterion: z.string().min(1),
  week: z.number().int().min(1),
});
export type MilestoneAlignment = z.infer<typeof MilestoneAlignmentSchema>;

/** L3 LoadPlan 全量落库：门结果与里程碑对齐一并存，审计时无需重算。 */
export const LoadPlanSchema = z.object({
  weeks: z.array(LoadWeekSchema),
  blocks: z.array(LoadBlockSchema),
  recovery_policy: z.array(RecoveryScenarioPolicySchema),
  strength_policy: z.array(StrengthPhasePolicySchema),
  checks: z.array(LoadCheckSchema),
  milestones: z.array(MilestoneAlignmentSchema),
});
export type LoadPlan = z.infer<typeof LoadPlanSchema>;

// ── anchor：生成时点锚（重生成/滚动种子）─────────────────────────────────────

export const MasterPlanAnchorSchema = z.object({
  as_of: DaySchema,
  vdot: z.number().positive().nullable(),
  vdot_source: z.string().nullable(),
  /** PMC 起点（CTL/ATL）；证据不足时为 null。 */
  seed: z.object({ ctl: z.number().nullable(), atl: z.number().nullable() }),
  /** 载荷系数标定版本（dose-calibration 的一次标定批次）。 */
  coefficient_version: z.string().min(1),
  projection: z.object({ capped: z.boolean(), residual: z.number() }),
});
export type MasterPlanAnchor = z.infer<typeof MasterPlanAnchorSchema>;

// ── audit：丹尼尔斯符合性审计（2026-11-02 拍板）──────────────────────────────

export const DanielsAuditVerdictSchema = z.enum(["pass", "warn", "fail"]);
export const DanielsAuditItemSchema = z.object({
  /** 审计维度（周级带 W 前缀）。 */
  item: z.string().min(1),
  verdict: DanielsAuditVerdictSchema,
  /** 原书口径描述。 */
  expectation: z.string(),
  actual: z.string(),
});
export type DanielsAuditItem = z.infer<typeof DanielsAuditItemSchema>;

export const DanielsAuditSchema = z.object({
  items: z.array(DanielsAuditItemSchema),
  summary: z.object({
    pass: z.number().int().nonnegative(),
    warn: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
  }),
});
export type DanielsAudit = z.infer<typeof DanielsAuditSchema>;

// ── 政策包 v3 = v2 课表（首期快照）+ 四段政策 ────────────────────────────────

export const MASTER_PLAN_V3_SCHEMA = "master-plan/v3" as const;

/**
 * v3 = MasterPlanSchema（v2 字段全保留）+ 政策包四段。
 * 读路径据此把 v3 投影回 v2 形状（小程序/Go 推送对新增字段零感知）；v2 的
 * 全部跨字段确定性规则继续生效，政策包只是**追加**段，不改课表语义。
 */
export const MasterPlanV3Schema = MasterPlanSchema.extend({
  schema: z.literal(MASTER_PLAN_V3_SCHEMA),
  policy: PhaseDivisionIntentSchema,
  skeleton: LoadPlanSchema,
  anchor: MasterPlanAnchorSchema,
  audit: DanielsAuditSchema,
  /** 首期课表快照的生成日；块界重生成后以 weekly 投影为准（spec §9）。 */
  snapshot_as_of: DaySchema,
});
export type MasterPlanV3 = z.infer<typeof MasterPlanV3Schema>;
