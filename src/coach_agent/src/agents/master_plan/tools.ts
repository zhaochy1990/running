/**
 * master_plan (season) specialist — mock tools (view + propose adjustment).
 *
 * Write operations produce a DRAFT proposal (applied=false) — the confirm/apply
 * gate lands later. Mock data for now.
 */

import { tool, type ToolRuntime } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachContext } from "../coachAgent.js";

const getMasterPlanSchema = z.object({});

const getMasterPlan = tool(
	async (
		_input: z.infer<typeof getMasterPlanSchema>,
		runtime: ToolRuntime<unknown, typeof CoachContext>,
	) => {
		const userId = runtime.context?.userId;
		console.log(`[mock] get_master_plan user=${userId}`);
		return {
			goal: "2026-11-01 上海马拉松，目标 sub-3:10",
			current_phase: "进展期 W9",
			next_milestone: "W10 30km 长距 @ MP+15s",
			phases: [
				{ name: "基础期", weeks: "W1-6", focus: "有氧 + 力量" },
				{ name: "进展期", weeks: "W7-12", focus: "阈值 + MP 配速" },
				{ name: "赛前期", weeks: "W13-15", focus: "比赛专项" },
				{ name: "减量期", weeks: "W16", focus: "taper" },
			],
		};
	},
	{
		name: "get_master_plan",
		description:
			"获取运动员的赛季/总体训练计划：目标、阶段、当前位置、下一里程碑",
		schema: getMasterPlanSchema,
	},
);

const proposeMasterAdjustmentSchema = z.object({
	request: z
		.string()
		.describe("运动员要求的赛季计划调整，如“把基础期延长两周”"),
});

const proposeMasterAdjustment = tool(
	async (
		{ request }: z.infer<typeof proposeMasterAdjustmentSchema>,
		runtime: ToolRuntime<unknown, typeof CoachContext>,
	) => {
		const userId = runtime.context?.userId;
		console.log(
			`[mock] propose_master_adjustment user=${userId} request=${request}`,
		);
		return {
			summary: `赛季计划调整草案（需运动员确认后才生效）：${request}`,
			ops: ["resize_phase: 基础期 W1-6 → W1-8", "shift: 进展期起点顺延 2 周"],
			applied: false,
		};
	},
	{
		name: "propose_master_adjustment",
		description: "针对赛季计划形成一个调整草案（不直接生效，等运动员确认）",
		schema: proposeMasterAdjustmentSchema,
	},
);

export const masterPlanTools = [getMasterPlan, proposeMasterAdjustment];
