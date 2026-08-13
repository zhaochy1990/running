/** Bounded, aggregated athlete context for master-plan generation. */

import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type { MasterPlanContextProvider } from "../graph/master_plan/index.js";
import { defineCoachTools } from "./common.js";

const getMasterPlanContextSchema = z.object({});

class MasterPlanContextTool {
	constructor(private readonly provider: MasterPlanContextProvider) {}

	async getMasterPlanContext(
		_input: z.infer<typeof getMasterPlanContextSchema>,
		runtime: CoachToolRuntime,
	) {
		const userId = runtime.context?.userId;
		if (!userId) {
			throw new Error(
				"get_master_plan_context: missing userId in runtime context",
			);
		}
		return this.provider.loadSnapshot(userId);
	}
}

/**
 * Return one bounded snapshot instead of exposing months of full Activity rows.
 * The provider aggregates recent history by week and macro history by month.
 */
export function createMasterPlanContextTools(
	provider: MasterPlanContextProvider,
): StructuredTool[] {
	const impl = new MasterPlanContextTool(provider);
	return defineCoachTools([
		{
			name: "get_master_plan_context",
			description:
				"一次获取生成赛季计划所需的有界聚合上下文：用户资料与伤病、PB、跑步校准、比赛候选、" +
				"近两年按月历史、近期按周训练与恢复、当前 CTL/ATL/Form，以及当前计划连续性。" +
				"生成新赛季计划时，在确认 race goal 后调用一次；不要再查询大区间逐条活动。",
			schema: getMasterPlanContextSchema,
			handler: (input, runtime) => impl.getMasterPlanContext(input, runtime),
		},
	]);
}
