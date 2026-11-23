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
import { WeeklyPlanSchema } from "../weekly_plan/schema.js";
import { WEEKDAY_VALUES } from "./card.js";
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

// ── availability：训练可用度（devops#1043）──────────────────────────────────
//
// 请求契约的 AvailabilitySchema 与落库 availability 共用下面两个 schema（单源）。
// 落库只存约束排课的四项明细 + 天数上限：首次生成据此排课，滚动续排从存量
// 还原同一份约束。有明确可用窗口时候选日同时满足窗口与禁跑日；窗口为空数组
// =未指定日内时段，候选日=一周七天扣除禁跑日。

/** 星期枚举（序=周一..周日；与表单卡的 WEEKDAY_VALUES 同源）。 */
export const AVAILABILITY_WEEKDAY = z.enum(WEEKDAY_VALUES);

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 日内可用时段（本地时间 HH:mm）。 */
export const TRAINING_WINDOW_SCHEMA = z.strictObject({
  day: AVAILABILITY_WEEKDAY,
  start_time: z.string().regex(TIME_OF_DAY),
  end_time: z.string().regex(TIME_OF_DAY),
});

/**
 * 落库 availability：天数上限必填 + 明细（全可选——#1043 之前的存量行只有天数上限）。
 * #1043 四项约束跑课排位（首次生成直带、滚动续排读回）；#222 力量两项供滚动/
 * 调整/伤病维持排力量课（读回侧缺省视为「未设置」，继续只出跑课并提示补选）。
 */
export const MasterPlanAvailabilitySchema = z.strictObject({
  weekly_run_days_max: z.int().min(1).max(7),
  available_training_windows: z.array(TRAINING_WINDOW_SCHEMA).optional(),
  unavailable_days: z.array(AVAILABILITY_WEEKDAY).optional(),
  max_session_duration_min: z.int().positive().optional(),
  allows_double_sessions: z.boolean().optional(),
  strength_sessions_per_week: z.int().nonnegative().optional(),
  strength_available_days: z.array(AVAILABILITY_WEEKDAY).optional(),
});
export type MasterPlanAvailability = z.infer<typeof MasterPlanAvailabilitySchema>;
/** 约束跑课排位的可用度明细（不含天数上限与力量项）。 */
export const AvailabilityDetailSchema = MasterPlanAvailabilitySchema.omit({
  weekly_run_days_max: true,
  strength_sessions_per_week: true,
  strength_available_days: true,
});
export type AvailabilityDetail = z.infer<typeof AvailabilityDetailSchema>;

const AVAILABILITY_DETAIL_KEYS = ["available_training_windows", "unavailable_days", "max_session_duration_min", "allows_double_sessions"] as const;

/**
 * availability 里约束排课的明细（校验后取出）；四项都没有=undefined（仅天数
 * 上限已知，具体日期未知）。生成入口、落库、存量读取三处共用，避免各自挑字段漂移。
 * 请求的 availability 还带首选长跑日与力量项（不进排位段）——先挑四项再过严格 schema。
 */
export function masterPlanAvailabilityDetail(value: unknown): AvailabilityDetail | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const present = AVAILABILITY_DETAIL_KEYS.filter((key) => record[key] !== undefined);
  if (present.length === 0) return undefined;
  const parsed = AvailabilityDetailSchema.safeParse(Object.fromEntries(present.map((key) => [key, record[key]])));
  if (!parsed.success) throw new Error(`availability 明细非法：${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
  // 禁跑日去重（请求 schema 不查重；与 #222 力量段读回的星期名去重口径一致）
  if (parsed.data.unavailable_days != null) parsed.data.unavailable_days = [...new Set(parsed.data.unavailable_days)];
  return parsed.data;
}

// ── 政策包 v3 = v2 课表（首期快照）+ 四段政策 ────────────────────────────────

export const MASTER_PLAN_V3_SCHEMA = "master-plan/v3" as const;

/**
 * v3 = MasterPlanSchema（v2 字段全保留）+ 政策包四段。
 * 读路径据此把 v3 投影回 v2 形状（小程序/Go 推送对新增字段零感知）；v2 的
 * 全部跨字段确定性规则继续生效，政策包只是**追加**段，不改课表语义。
 */
export const MasterPlanV3Schema = MasterPlanSchema.extend({
  schema: z.literal(MASTER_PLAN_V3_SCHEMA),
  master_plan_id: z.uuid().optional(),
  candidate_job_id: z.uuid().optional(),
  candidate_user_id: z.uuid().optional(),
  weekly_docs: z.array(WeeklyPlanSchema).max(6).optional(),
  policy: PhaseDivisionIntentSchema,
  skeleton: LoadPlanSchema,
  anchor: MasterPlanAnchorSchema,
  audit: DanielsAuditSchema,
  /** 首期课表快照的生成日；块界重生成后以 weekly 投影为准（spec §9）。 */
  snapshot_as_of: DaySchema,
  /**
  /**
   * 训练可用性（#858 PR-A，整段可选——v3 写路径落地前的存量行没有该字段）：
   * 滚动 job 从存量 content 构造 RollingMasterInput 需要 weekly_run_days_max；
   * #1043 起随存约束跑课排位的四项明细（存量行只有天数上限=具体日期未知）；
   * #222 力量偏好两项随 content 落库（读回侧缺省视为「未设置」，滚动继续只出跑课并提示补选）。
   */
  availability: MasterPlanAvailabilitySchema.optional(),
});
export type MasterPlanV3 = z.infer<typeof MasterPlanV3Schema>;
