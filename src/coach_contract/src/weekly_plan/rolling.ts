import { z } from "zod/v4";
import type { LoadPlan, MasterPlanAnchor, PhaseDivisionIntent } from "../master_plan/policy.js";
import type { WeeklyPlan } from "./schema.js";

/**
 * `generate_rolling_block` job 的请求契约（#858 PR-A Round 2）：滚动 job 不带
 * 业务输入——存量 master 计划从 DB 读（policy/skeleton/anchor/availability），
 * 已落库 weekly 行从 Go 内部 list 端点拉。`master_plan_id` 仅作一致性校验
 * （与读到的 active 行不一致 = permanent error），`as_of` 缺省=现在。
 */
export const RollingJobRequest = z
  .object({
    request_id: z.string().min(1),
    /** 期望的 active master plan id（校验用，不驱动取数）。 */
    master_plan_id: z.string().min(1).optional(),
    /** 生成时点（ISO instant；缺省=现在，内部归一上海日历日）。 */
    as_of: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type RollingJobRequest = z.infer<typeof RollingJobRequest>;

// ── #858 PR-C：调整提案（plan_adjustment / generate_adjustment）──────────────

/**
 * 追问原因六选一（票面 #858 定稿，与 coach_agent detect/detector 的 AskReason
 * 同枚举——契约包不依赖 agent，此处单源声明、两侧注释互指）。
 * injured 在本引擎 unsupported（PR-D 伤病模式接管），枚举含它仅为传输完整。
 */
export const ADJUST_REASONS = ["pace_unmet", "volume_unmet", "no_time", "injured", "ran_other", "over_delivered"] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number];

/**
 * `generate_adjustment` job 的请求契约（#858 PR-C）：换因重生成通道。夜检/
 * mp 先经 Go 内部端点建（或刷新）pending 提案行；用户在弹窗改选原因时，
 * mp 调 coach_api enqueue 本 job（携带最终原因），worker 重跑调整投影并经
 * 内部端点回填 pending 行 payload。`event_week_start`=触发本次调整的偏差周
 * （周一 YYYY-MM-DD，与 plan_adjustment 行对齐）；`master_plan_id` 仅一致性
 * 校验（同 rolling job 语义）。
 */
export const AdjustJobRequest = z
  .object({
    request_id: z.string().min(1),
    /** 期望的 active master plan id（校验用，不驱动取数）。 */
    master_plan_id: z.string().min(1).optional(),
    /** 偏差事件周周一（YYYY-MM-DD；plan_adjustment.event_week_start 同值）。 */
    event_week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "event_week_start 须为 YYYY-MM-DD"),
    /** 调用方已解析的最终原因（预判或用户改选；injured 由 handler 拦截为 permanent error）。 */
    reason: z.enum(ADJUST_REASONS),
    /**
     * #858 PR-C 夜检通道：true=无匹配 pending 行时**建行**而不是 no-op——
     * worker 先跑检测+投影，经内部 upsert 端点落 pending 行（payload=投影
     * 产物、question=检测证据润色的问句）。Go 侧事件已关闭（409）= no-op
     * 成功（用户已答过，不重复追问）。mp 换因链路不带此标志。
     */
    create_pending: z.boolean().optional(),
    /** 生成时点（ISO instant；缺省=现在，内部归一上海日历日）。 */
    as_of: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type AdjustJobRequest = z.infer<typeof AdjustJobRequest>;

/**
 * plan_adjustment.payload 的结构（#858 PR-C，TS 侧单源）：Go 存 LONGTEXT 原样
 * JSON、API 透传，mp 直接消费。weekly_docs 为完整 weekly-plan/v1 文档数组
 * （含 week_name），accept 时 Go 逐周 batch-apply 覆盖对应周行。
 */
export interface AdjustProposalPayload {
  reason: AdjustReason;
  window: { start_week: number; end_week: number };
  weekly_docs: WeeklyPlan[];
  /** 新周文档 target km vs 现 weekly 行的对照（弹窗展示「怎么改」）。 */
  diff: Array<{ week: number; old_km: number; new_km: number }>;
  /** detector 一句话证据（弹窗直接展示）。 */
  evidence: string;
  audit_summary: { pass: number; warn: number; fail: number };
}

/**
 * 滚动投影的 master 侧存量输入（#858 PR-A Round 1）：赛季开始时 master 图落库
 * 的政策包 + 首批课表末周号。滚动内核据此 + 新鲜 L1 证据重投 L3/L4（**不重跑
 * L2**——阶段政策是赛季意图，块界滚动只重排周量与课表）。
 *
 * - skeleton 是**存量**骨架：滚动偏差（km_deviation_pct）的基准，不参与新投影。
 * - anchor 仅上下文用：配速不沿用存量 vdot——滚动一律用新鲜 VDOT
 *   （evidence.current_capability.vdot）重算投影带。
 * - lastGeneratedWeek = 快照周 ∪ 已落库 weekly 行的最大周号（首批门控后 =
 *   min(首阶段末周, 6)；首批内重生成不变）。
 */
export interface RollingMasterInput {
  masterPlanId: string;
  /** 第 1 周周一（YYYY-MM-DD，master v2 快照 start_date 同值）。 */
  planStartMonday: string;
  /** 全跑道周数（政策末阶段 end_week）。 */
  totalWeeks: number;
  race: {
    name: string;
    date: string;
    targetTime: string;
    /** 目标距离（master goal 同枚举；缺省 FM——判断层教义目前只验证过 FM）。 */
    distance?: "FM" | "HM";
  };
  availability: { weeklyRunDaysMax: number };
  policy: PhaseDivisionIntent;
  /** 存量骨架（偏差基准）。 */
  skeleton: LoadPlan;
  /** 仅上下文用（配速不沿用，见文件头）。 */
  anchor: MasterPlanAnchor;
  /** 快照周 ∪ 已落库 weekly 行的最大周号。 */
  lastGeneratedWeek: number;
}
