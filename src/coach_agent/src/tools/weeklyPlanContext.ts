import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type { WeeklyPlanContextProvider } from "../data/weeklyPlanContextProvider.js";
import { defineCoachTools } from "./common.js";

const getWeeklyPlanContextSchema = z.object({});

class WeeklyPlanContextTool {
  constructor(private readonly provider: WeeklyPlanContextProvider) {}

  async getWeeklyPlanContext(_input: z.infer<typeof getWeeklyPlanContextSchema>, runtime: CoachToolRuntime) {
    const userId = runtime.context?.userId;
    const asof = runtime.context?.asof;
    if (!userId) {
      throw new Error("get_weekly_plan_context: missing userId in runtime context");
    }
    if (!asof) {
      throw new Error("get_weekly_plan_context: missing asof in runtime context");
    }
    return this.provider.loadSnapshot(userId, asof);
  }
}

/** Build the bounded context tool used to generate or adjust a weekly plan. */
export function createWeeklyPlanContextTools(provider: WeeklyPlanContextProvider): StructuredTool[] {
  const impl = new WeeklyPlanContextTool(provider);
  return defineCoachTools([
    {
      name: "get_weekly_plan_context",
      description:
        "一次获取有界的周计划上下文：当前赛季 phase、阶段里程碑与本周 stage、确定性实际负荷锚点、最近四周计划/实际摘要、最近 28 天活动和周反馈、" +
        "STRIDE CTL/ATL/Form/负荷趋势、伤病限制、原始 RHR/HRV 恢复趋势，以及用户画像（年龄/体重/乳酸阈值心率/阈值配速/静息心率/心率与配速区间）。",
      schema: getWeeklyPlanContextSchema,
      handler: (input, runtime) => impl.getWeeklyPlanContext(input, runtime),
    },
  ]);
}
