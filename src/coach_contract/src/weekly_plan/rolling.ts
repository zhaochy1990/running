import { z } from "zod/v4";
import type { LoadPlan, MasterPlanAnchor, PhaseDivisionIntent } from "../master_plan/policy.js";

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
