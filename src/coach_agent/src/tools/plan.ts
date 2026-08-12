/** Read-only master and weekly plan tools backed by the shared `stride` MySQL DB. */

import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type {
	MasterPlanDocument,
	StrideDataStore,
	WeeklyPlanDocument,
} from "../persistence/index.js";
import { defineCoachTools } from "./common.js";

const WEEK_NAME_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/;

const getMasterPlanSchema = z.object({});
const getWeeklyPlanSchema = z.object({
	weekName: z
		.string()
		.regex(WEEK_NAME_RE, "expected YYYY-MM-DD_MM-DD")
		.describe("week name, format: YYYY-MM-DD_MM-DD, example 2026-07-20_07-26"),
});

export interface PlanStore {
	getMasterPlan(userId: string): Promise<MasterPlanDocument | null>;
	getWeeklyPlan(
		userId: string,
		weekName: string,
	): Promise<WeeklyPlanDocument | null>;
}

class MySQLPlanTool {
	constructor(private readonly store: PlanStore) {}

	async getMasterPlan(
		_input: z.infer<typeof getMasterPlanSchema>,
		runtime: CoachToolRuntime,
	): Promise<MasterPlanDocument | null> {
		return this.store.getMasterPlan(requireUserId(runtime, "get_master_plan"));
	}

	async getWeeklyPlan(
		input: z.infer<typeof getWeeklyPlanSchema>,
		runtime: CoachToolRuntime,
	): Promise<WeeklyPlanDocument | null> {
		if (!WEEK_NAME_RE.test(input.weekName)) {
			throw new Error(
				`get_weekly_plan: invalid weekName ${input.weekName}, expected YYYY-MM-DD_MM-DD`,
			);
		}

		return this.store.getWeeklyPlan(
			requireUserId(runtime, "get_week_plan"),
			input.weekName,
		);
	}
}

export function createPlanTools(store: StrideDataStore): StructuredTool[] {
	const impl = new MySQLPlanTool(store);
	return defineCoachTools([
		{
			name: "get_master_plan",
			description:
				"查询用户当前激活的赛季训练计划，包括目标、阶段、里程碑与周框架。无激活计划时返回 null。",
			schema: getMasterPlanSchema,
			handler: (input, runtime) => impl.getMasterPlan(input, runtime),
		},
		{
			name: "get_weekly_plan",
			description:
				"查询运动员某一周的训练计划，包含每天训练、营养与教练备注。需要使用weekName指定查询周。没有匹配计划时返回 null。",
			schema: getWeeklyPlanSchema,
			handler: (input, runtime) => impl.getWeeklyPlan(input, runtime),
		},
	]);
}

function requireUserId(runtime: CoachToolRuntime, toolName: string): string {
	const userId = runtime.context?.userId;
	if (!userId)
		throw new Error(`${toolName}: missing userId in runtime context`);
	return userId;
}

function currentShanghaiWeekName(now: Date = new Date()): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(now);
	const value = (type: string) =>
		parts.find((part) => part.type === type)!.value;
	const shanghaiToday = new Date(
		`${value("year")}-${value("month")}-${value("day")}T00:00:00Z`,
	);
	const monday = new Date(shanghaiToday);
	monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
	const sunday = new Date(monday);
	sunday.setUTCDate(sunday.getUTCDate() + 6);
	return `${monday.toISOString().slice(0, 10)}_${sunday.toISOString().slice(5, 10)}`;
}
