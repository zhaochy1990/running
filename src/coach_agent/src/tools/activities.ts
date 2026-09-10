/**
 * Athlete activity tools — read watch-synced training data through DataProvider.
 *
 * Layered on purpose:
 *   - `ActivitiesToolImpl` = domain logic (pure and LangChain-agnostic).
 *   - `createActivitiesTools(store)` = adapter that binds the store and turns each
 *     domain method into a LangChain tool via the generic {@link defineCoachTools}
 *     factory — no hand-written `tool(...)` boilerplate.
 *
 * `userId` is read from `runtime.context`, never a tool argument (see
 * src/coach_agent/AGENTS.md).
 *
 * Two tools by design:
 *   - `get_activities_by_date_range` — list of activities in a date range, each
 *     WITHOUT `laps`. Keeps the list light so it never blows up context.
 *   - `get_activity_details` — full detail (incl. `laps`) for ONE activity, keyed
 *     by `labelId`. Fetch this only when a lap/segment breakdown is actually needed.
 */

import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type { Activity, DataProvider } from "../data/dataProvider.js";
import { defineCoachTools } from "./common.js";

const getActivitiesByDateRangeSchema = z.object({
  startDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .describe("查询起始日期（含），格式 YYYY-MM-DD（Asia/Shanghai 日历日）。回答“今天/最近跑得怎么样”时，围绕 asof 查最近 7 天足够。"),
  endDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .optional()
    .describe("查询结束日期（含），格式 YYYY-MM-DD，缺省为 runtime context 的 asof"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("最多返回最近多少条运动（按 date 升序取末尾）。缺省 30。区间内运动数超过该值会截断并置 truncated=true。"),
});

type GetActivitiesByDateRangeInput = z.infer<typeof getActivitiesByDateRangeSchema>;

const getActivityDetailSchema = z.object({
  labelId: z.string().min(1).describe("运动记录的唯一 ID（get_activities_by_date_range 返回的 labelId）。"),
});

type GetActivityDetailInput = z.infer<typeof getActivityDetailSchema>;

/** 未显式传 `limit` 时的默认值：足以覆盖一次训练问答，又不会撑爆上下文/触发落盘。 */
const DEFAULT_ACTIVITIES_LIMIT = 30;

/** Domain interface — pure business logic, decoupled from LangChain. */
interface ActivitiesTool {
  getActivitiesByDateRange(
    input: GetActivitiesByDateRangeInput,
    runtime: CoachToolRuntime,
  ): Promise<{
    activities: Activity[];
    provenance: { source: "stride"; vendor_derived: false };
    truncated: boolean;
  }>;
  getActivityDetail(
    input: GetActivityDetailInput,
    runtime: CoachToolRuntime,
  ): Promise<{
    activity: Activity | null;
    provenance: { source: "stride"; vendor_derived: false };
  }>;
}

class ActivitiesToolImpl implements ActivitiesTool {
  constructor(private readonly store: DataProvider) {}

  async getActivitiesByDateRange(
    input: GetActivitiesByDateRangeInput,
    runtime: CoachToolRuntime,
  ): Promise<{
    activities: Activity[];
    provenance: { source: "stride"; vendor_derived: false };
    truncated: boolean;
  }> {
    const userId = runtime.context?.userId;
    if (!userId) {
      throw new Error("get_activities_by_date_range: missing userId in runtime context");
    }
    const asof = runtime.context?.asof;
    if (!asof) {
      throw new Error("get_activities_by_date_range: missing asof in runtime context");
    }
    const endDay = input.endDay ?? asof;
    const limit = input.limit ?? DEFAULT_ACTIVITIES_LIMIT;
    // 列表走 summaries：SQL 层面就不碰 laps 表。要分段明细再去 get_activity_details。
    const all = await this.store.getActivitySummariesByDateRange(userId, input.startDay, endDay);
    const truncated = all.length > limit;
    // date 升序，取末尾若干条 = 区间内最近的运动。
    const activities = truncated ? all.slice(-limit) : all;
    return {
      activities,
      provenance: { source: "stride", vendor_derived: false },
      truncated,
    };
  }

  async getActivityDetail(
    input: GetActivityDetailInput,
    runtime: CoachToolRuntime,
  ): Promise<{
    activity: Activity | null;
    provenance: { source: "stride"; vendor_derived: false };
  }> {
    const userId = runtime.context?.userId;
    if (!userId) {
      throw new Error("get_activity_details: missing userId in runtime context");
    }
    const activity = await this.store.getActivityDetail(userId, input.labelId);
    return {
      activity,
      provenance: { source: "stride", vendor_derived: false },
    };
  }
}

/**
 * Build the athlete-activity tools with the data store injected.
 *
 * @example
 * ```ts
 * tools: [...createActivitiesTools(store)]
 * ```
 */
export function createActivitiesTools(store: DataProvider): StructuredTool[] {
  const impl = new ActivitiesToolImpl(store);
  return defineCoachTools([
    {
      name: "get_activities_by_date_range",
      description:
        "获取运动员在某个日期区间（Asia/Shanghai 日历日，含起止两端）的运动清单，按 date 升序返回。每条运动只含汇总字段、`laps` 为空 []；要看分段明细请用 get_activity_details(labelId)。" +
        "默认最多返回最近 30 条（按 date 升序取末尾），超出则截断并置 truncated=true。startDay 必填；endDay 缺省为 runtime context 的 asof。" +
        "回答“今天/最近跑得怎么样”时，围绕 asof 查最近 7 天、endDay 留空即可。",
      schema: getActivitiesByDateRangeSchema,
      handler: (input, runtime) => impl.getActivitiesByDateRange(input, runtime),
    },
    {
      name: "get_activity_details",
      description:
        "获取单条运动的完整明细，含 `laps` 分段（每公里/每秒）。用 get_activities_by_date_range 拿到的 labelId 传入。一次只取一条，用于需要看分段/间歇/配速拆解的场景。",
      schema: getActivityDetailSchema,
      handler: (input, runtime) => impl.getActivityDetail(input, runtime),
    },
  ]);
}
