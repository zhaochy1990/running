/** Read-only master and weekly plan tools backed by DataProvider. */

import type { StructuredTool } from "@langchain/core/tools";
import { mondayOnOrBefore, weekFolder } from "@stride/contract";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type { DataProvider, MasterPlanDocument, WeeklyPlanDocument } from "../data/dataProvider.js";
import { defineCoachTools } from "./common.js";

const getMasterPlanSchema = z.object({});
const getWeeklyPlanSchema = z.object({
  weekStart: z.iso.date().describe("周起始日（周一），格式 YYYY-MM-DD，例 2026-07-20。传该周内任意一天都会归一到周一。"),
});

export interface PlanStore {
  getMasterPlan(userId: string, day: string): Promise<MasterPlanDocument | null>;
  getWeeklyPlan(userId: string, weekName: string): Promise<WeeklyPlanDocument | null>;
}

class PlanToolImpl {
  constructor(private readonly store: PlanStore) {}

  async getMasterPlan(_input: z.infer<typeof getMasterPlanSchema>, runtime: CoachToolRuntime): Promise<MasterPlanDocument | null> {
    const userId = requireUserId(runtime, "get_master_plan");
    const asof = requireAsOf(runtime, "get_master_plan");
    return this.store.getMasterPlan(userId, asof);
  }

  async getWeeklyPlan(input: z.infer<typeof getWeeklyPlanSchema>, runtime: CoachToolRuntime): Promise<WeeklyPlanDocument | null> {
    const userId = requireUserId(runtime, "get_weekly_plan");
    // MySQL keys weekly plans by their Monday, so normalize the caller's
    // week-start date to the canonical Monday-Sunday folder identity.
    return this.store.getWeeklyPlan(userId, weekFolder(mondayOnOrBefore(input.weekStart)));
  }
}

export function createPlanTools(store: DataProvider): StructuredTool[] {
  const impl = new PlanToolImpl(store);
  return defineCoachTools([
    {
      name: "get_master_plan",
      description: "查询用户当前激活的赛季训练计划，包括目标、阶段、里程碑与周框架。无激活计划时返回 null。",
      schema: getMasterPlanSchema,
      handler: (input, runtime) => impl.getMasterPlan(input, runtime),
    },
    {
      name: "get_weekly_plan",
      description: "查询运动员某一周（周一起算的自然周）的训练计划，包含每天训练、营养与教练备注。weekStart 指定查询周的周一，没有匹配计划时返回 null。",
      schema: getWeeklyPlanSchema,
      handler: (input, runtime) => impl.getWeeklyPlan(input, runtime),
    },
  ]);
}

function requireUserId(runtime: CoachToolRuntime, toolName: string): string {
  const userId = runtime.context?.userId;
  if (!userId) throw new Error(`${toolName}: missing userId in runtime context`);
  return userId;
}

function requireAsOf(runtime: CoachToolRuntime, toolName: string): string {
  const asof = runtime.context?.asof;
  if (!asof) throw new Error(`${toolName}: missing asof in runtime context`);
  return asof;
}
