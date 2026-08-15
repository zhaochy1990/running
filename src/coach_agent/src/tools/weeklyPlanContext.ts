import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type { WeeklyPlanContextProvider } from "../persistence/weeklyPlanContextProvider.js";
import { defineCoachTools } from "./common.js";

const getWeeklyPlanContextSchema = z.object({});

class WeeklyPlanContextTool {
	constructor(private readonly provider: WeeklyPlanContextProvider) {}

	async getWeeklyPlanContext(
		_input: z.infer<typeof getWeeklyPlanContextSchema>,
		runtime: CoachToolRuntime,
	) {
		const userId = runtime.context?.userId;
		const asof = runtime.context?.asof;
		if (!userId) {
			throw new Error(
				"get_weekly_plan_context: missing userId in runtime context",
			);
		}
		if (!asof) {
			throw new Error(
				"get_weekly_plan_context: missing asof in runtime context",
			);
		}
		return this.provider.loadSnapshot(userId, asof);
	}
}

/** Build the bounded context tool used to generate or adjust a weekly plan. */
export function createWeeklyPlanContextTools(
	provider: WeeklyPlanContextProvider,
): StructuredTool[] {
	const impl = new WeeklyPlanContextTool(provider);
	return defineCoachTools([
		{
			name: "get_weekly_plan_context",
			description:
				"一次获取周计划决策所需的有界上下文：当前赛季 phase 与本周 stage、最近 28 天活动和周反馈、" +
				"STRIDE CTL/ATL/Form/负荷趋势、伤病限制、原始 RHR/HRV 恢复趋势，以及乳酸阈值心率、阈值配速和训练区间。" +
				"生成或调整周计划前调用一次；不要再分别重复查询这些数据。",
			schema: getWeeklyPlanContextSchema,
			handler: (input, runtime) => impl.getWeeklyPlanContext(input, runtime),
		},
	]);
}
