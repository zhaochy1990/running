/**
 * Athlete activity tools — read watch-synced training data from the shared
 * `stride` MySQL DB.
 *
 * Layered on purpose:
 *   - `MySQLActivitiesTool` = domain logic (pure, LangChain-agnostic, unit-test
 *     with a fake `StrideDataStore`).
 *   - `createActivitiesTools(store)` = adapter that binds the store and turns each
 *     domain method into a LangChain tool via the generic {@link defineCoachTools}
 *     factory — no hand-written `tool(...)` boilerplate.
 *
 * `userId` is read from `runtime.context`, never a tool argument (see
 * src/coach_agent/AGENTS.md).
 */

import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type { Activity, StrideDataStore } from "../persistence/index.js";
import { defineCoachTools } from "./common.js";

const getActivitiesByDateRangeSchema = z.object({
  startDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .describe("查询起始日期（含），格式 YYYY-MM-DD（Asia/Shanghai 日历日）"),
  endDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .optional()
    .describe("查询结束日期（含），格式 YYYY-MM-DD，缺省为 runtime context 的 asof"),
});

type GetActivitiesByDateRangeInput = z.infer<typeof getActivitiesByDateRangeSchema>;

/** Domain interface — pure business logic, decoupled from LangChain. */
interface ActivitiesTool {
  getActivitiesByDateRange(input: GetActivitiesByDateRangeInput, runtime: CoachToolRuntime): Promise<Activity[]>;
}

/** MySQL-backed implementation (reads the `stride` activities table). */
class MySQLActivitiesTool implements ActivitiesTool {
  constructor(private readonly store: StrideDataStore) {}

  async getActivitiesByDateRange(input: GetActivitiesByDateRangeInput, runtime: CoachToolRuntime): Promise<Activity[]> {
    const userId = runtime.context?.userId;
    if (!userId) {
      throw new Error("get_activities_by_date_range: missing userId in runtime context");
    }
    const asof = runtime.context?.asof;
    if (!asof) {
      throw new Error("get_activities_by_date_range: missing asof in runtime context");
    }
    const endDay = input.endDay ?? asof;
    return this.store.getActivitiesByDateRange(userId, input.startDay, endDay);
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
export function createActivitiesTools(store: StrideDataStore): StructuredTool[] {
  const impl = new MySQLActivitiesTool(store);
  return defineCoachTools([
    {
      name: "get_activities_by_date_range",
      description:
        "获取运动员在某个日期区间（Asia/Shanghai 日历日，含起止两端）记录的所有运动，按时间最早在前。" +
        "startDay 必填；endDay 缺省为 runtime context 的 asof。回答“最近状态/最近跑得怎么样”时，围绕 asof 向前查询，endDay 留空即可。",
      schema: getActivitiesByDateRangeSchema,
      handler: (input, runtime) => impl.getActivitiesByDateRange(input, runtime),
    },
  ]);
}
