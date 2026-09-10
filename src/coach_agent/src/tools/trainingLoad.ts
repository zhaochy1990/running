/**
 * Training-load tools — read STRIDE daily PMC through DataProvider.
 *
 * 与 activities 工具同构：
 *   - `TrainingLoadToolImpl` = 纯领域逻辑，与 LangChain 无关。
 *   - `createTrainingLoadTools(store)` = 适配器，绑定 store 并经通用
 *     {@link defineCoachTools} 工厂把每个领域方法变成 LangChain 工具。
 *
 * `userId` 从 `runtime.context` 读取，绝不作为工具入参（见 src/coach_agent/AGENTS.md）。
 */

import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type { DailyTrainingLoad, DataProvider } from "../data/dataProvider.js";
import { defineCoachTools } from "./common.js";

const getDailyTrainingLoadSchema = z.object({
  startDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .describe("查询起始日期（含），格式 YYYY-MM-DD（Asia/Shanghai 日历日）。回答“当前状态/趋势”时围绕 asof 查最近 30 天足够。"),
  endDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .optional()
    .describe("查询结束日期（含），格式 YYYY-MM-DD，缺省为 runtime context 的 asof"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .describe("最多返回最近多少天（按 date 升序取末尾）。缺省 30。区间内天数超过该值会截断并置 truncated=true。慢性负荷/趋势分析取最近 30 天足够。"),
});

type GetDailyTrainingLoadInput = z.infer<typeof getDailyTrainingLoadSchema>;

/** 未显式传 `limit` 时的默认值：覆盖慢性负荷所需窗口，又不会把几十 MB 的天数撑爆上下文。 */
const DEFAULT_TRAINING_LOAD_LIMIT = 30;

/** 领域接口 —— 纯业务逻辑，与 LangChain 解耦。 */
interface TrainingLoadTool {
  getDailyTrainingLoad(
    input: GetDailyTrainingLoadInput,
    runtime: CoachToolRuntime,
  ): Promise<{
    available: boolean;
    stride_training_load: DailyTrainingLoad[];
    truncated: boolean;
    missing_reason?: "stride_load_not_computed";
    provenance: { source: "stride"; vendor_derived: false };
  }>;
}

class TrainingLoadToolImpl implements TrainingLoadTool {
  constructor(private readonly store: DataProvider) {}

  async getDailyTrainingLoad(
    input: GetDailyTrainingLoadInput,
    runtime: CoachToolRuntime,
  ): Promise<{
    available: boolean;
    stride_training_load: DailyTrainingLoad[];
    truncated: boolean;
    missing_reason?: "stride_load_not_computed";
    provenance: { source: "stride"; vendor_derived: false };
  }> {
    const userId = runtime.context?.userId;
    if (!userId) {
      throw new Error("get_daily_training_load: missing userId in runtime context");
    }
    const asof = runtime.context?.asof;
    if (!asof) {
      throw new Error("get_daily_training_load: missing asof in runtime context");
    }
    const endDay = input.endDay ?? asof;
    const limit = input.limit ?? DEFAULT_TRAINING_LOAD_LIMIT;
    const all = await this.store.getDailyTrainingLoadByDateRange(userId, input.startDay, endDay);
    const truncated = all.length > limit;
    // date 升序，取末尾若干条 = 区间内最近的天。慢性负荷/趋势分析用最近 30 天足够。
    const strideTrainingLoad = truncated ? all.slice(-limit) : all;
    return {
      available: strideTrainingLoad.length > 0,
      stride_training_load: strideTrainingLoad,
      truncated,
      ...(strideTrainingLoad.length === 0 ? { missing_reason: "stride_load_not_computed" as const } : {}),
      provenance: { source: "stride", vendor_derived: false },
    };
  }
}

/**
 * 构建训练负荷工具（注入数据存储）。
 *
 * @example
 * ```ts
 * tools: [...createTrainingLoadTools(store)]
 * ```
 */
export function createTrainingLoadTools(store: DataProvider): StructuredTool[] {
  const impl = new TrainingLoadToolImpl(store);
  return defineCoachTools([
    {
      name: "get_daily_training_load",
      description:
        "获取运动员在某个日期区间（Asia/Shanghai 日历日，含起止两端）的每日 STRIDE 训练负荷（PMC），按日期最早在前。" +
        "每天返回：长期负荷 chronicLoad（CTL，约 42 天）、短期负荷 acuteLoad（ATL，约 7 天）、" +
        "负荷比 loadRatio（acute/chronic）、form（chronic−acute，正=更 fresh，负=更疲劳）、" +
        "当日 STRIDE 训练剂量 trainingDose 与数据覆盖状态 coverageStatus。所有负荷均为 STRIDE 自算，不含厂商派生值。" +
        "默认最多返回最近 30 天（按 date 升序取末尾），超出则截断并置 truncated=true。startDay 必填；endDay 缺省为 runtime context 的 asof。" +
        "回答“我现在疲劳吗/负荷高不高/恢复得怎么样/能不能加量”这类问题时，围绕 asof 查最近 30 天即可。",
      schema: getDailyTrainingLoadSchema,
      handler: (input, runtime) => impl.getDailyTrainingLoad(input, runtime),
    },
  ]);
}
