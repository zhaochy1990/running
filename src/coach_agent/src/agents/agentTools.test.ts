import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import {
	MasterPlanDirectResponseSchema,
	WeeklyPlanDirectResponseSchema,
} from "@stride/contract";
import type { ModelConfig } from "../config/config.js";
import { StrideDataStore } from "../persistence/index.js";
import { CoachContext } from "./coachAgent.js";
import {
	getMasterPlanGeneratorSubagent,
	getMasterPlanSubagent,
} from "./master_plan/agent.js";
import {
	createPlanPassthroughMiddleware,
	getDirectPlanTaskResult,
	getMasterPlanTaskResult,
} from "./masterPlanPassthrough.js";
import { MASTER_PLAN_PROMPT } from "./prompts.js";
import { getQaSubagent } from "./qa/agent.js";
import {
	getCoachSubagent,
	getWeeklyPlanGeneratorSubagent,
} from "./weekly_plan/agent.js";

const TEST_API_KEY_ENV = "COACH_AGENT_TEST_API_KEY";
const previousTestApiKey = process.env[TEST_API_KEY_ENV];
process.env[TEST_API_KEY_ENV] = "test-key";
after(() => {
	if (previousTestApiKey === undefined) delete process.env[TEST_API_KEY_ENV];
	else process.env[TEST_API_KEY_ENV] = previousTestApiKey;
});

const modelConfig: ModelConfig = {
	name: "test",
	provider: "openai-compatible",
	model: "test-model",
	deployment: "test",
	endpoint: "http://127.0.0.1:1",
	auth: "api-key",
	api_kind: "responses",
	api_key_env: TEST_API_KEY_ENV,
	max_tokens: 100,
	timeout_s: 1,
};

test("master-plan skills are present in the compiled virtual filesystem root", async () => {
	const skillsDir = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"skills",
	);
	await Promise.all([
		access(join(skillsDir, "analyze-race", "SKILL.md")),
		access(join(skillsDir, "generate-master-plan", "SKILL.md")),
	]);
});

test("master-plan prompt gates athlete data behind a complete race goal", () => {
	assert.match(MASTER_PLAN_PROMPT, /先只调用 get_master_plan/);
	assert.match(MASTER_PLAN_PROMPT, /比赛地点可选/);
	assert.match(MASTER_PLAN_PROMPT, /暂停并等待用户回答/);
});

test("coach context requires a strict Shanghai asof day", () => {
	assert.deepEqual(
		CoachContext.parse({ userId: "athlete", asof: "2026-05-01" }),
		{
			userId: "athlete",
			asof: "2026-05-01",
		},
	);
	assert.throws(() => CoachContext.parse({ userId: "athlete" }));
	assert.throws(() =>
		CoachContext.parse({ userId: "athlete", asof: "2026-05-01T00:00:00Z" }),
	);
	assert.throws(() =>
		CoachContext.parse({ userId: "athlete", asof: "2026-02-30" }),
	);
});

test("master-plan agent has a machine-enforced structured output contract", () => {
	assert.match(MASTER_PLAN_PROMPT, /结构化输出/);
	const store = new StrideDataStore({} as never);
	const generator = getMasterPlanGeneratorSubagent(store, modelConfig);
	const reader = getMasterPlanSubagent(store, modelConfig);
	assert.equal(generator.responseFormat, MasterPlanDirectResponseSchema);
	assert.equal(reader.responseFormat, undefined);
	assert.ok(generator.skills.includes("/generate-master-plan/"));
	assert.ok(!reader.skills.includes("/generate-master-plan/"));
	assert.ok(!generator.tools.some((tool) => tool.name === "get_current_time"));
});

test("weekly-plan reader and generator keep distinct contracts", () => {
	const store = new StrideDataStore({} as never);
	const reader = getCoachSubagent(store, modelConfig);
	const generator = getWeeklyPlanGeneratorSubagent(store, modelConfig);
	for (const subagent of [reader, generator]) {
		const names = subagent.tools.map((tool) => tool.name);
		assert.ok(names.includes("get_weekly_plan_context"));
		assert.ok(!names.includes("get_current_time"));
	}
	assert.ok(
		!reader.tools.some((tool) => tool.name === "simulate_weekly_plan_load"),
	);
	assert.ok(
		generator.tools.some((tool) => tool.name === "simulate_weekly_plan_load"),
	);
	assert.ok(
		generator.middleware.every(
			(middleware) => middleware.name !== "WeeklyPlanLoadSimulationMiddleware",
		),
	);
	assert.equal(reader.responseFormat, undefined);
	assert.deepEqual(reader.skills, []);
	assert.equal(generator.responseFormat, WeeklyPlanDirectResponseSchema);
	assert.ok(generator.skills.includes("/generate-weekly-plan/"));
});

test("weekly-plan skill routes every canonical phase name", async () => {
	const skillsDir = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"skills",
	);
	const skill = await readFile(
		join(skillsDir, "generate-weekly-plan", "SKILL.md"),
		"utf8",
	);
	for (const phase of [
		"base",
		"build",
		"speed",
		"marathon",
		"taper",
		"recovery",
	])
		assert.match(skill, new RegExp(phase));
	assert.match(skill, /把前一天设为休息日或不超过周距离目标 10% 的短恢复跑/);
	assert.match(skill, /不要超过 12%/);
	assert.match(skill, /把恢复视为一票否决/);
	assert.match(skill, /80-90%/);
});

const masterPlan = {
	status: "draft" as const,
	goal: {
		race_name: "测试马拉松",
		distance: "FM" as const,
		race_date: "2026-10-18",
		target_time: "2:50:00",
		timezone: "Asia/Shanghai" as const,
		location: "西安",
	},
	start_date: "2026-08-10",
	end_date: "2026-10-18",
	total_weeks: 1,
	phases: [
		{
			name: "base" as const,
			start_date: "2026-08-10",
			end_date: "2026-10-18",
			focus: "基础",
			weekly_distance_km_low: 70,
			weekly_distance_km_high: 80,
			key_session_types: ["长跑"],
			milestones: [],
			key_workouts: "长跑",
			monitoring_triggers: ["疼痛"],
			coach_note: "注意恢复",
			strength: { sessions_per_week: 2, focus: "核心", timing: "轻松跑后" },
			recovery: {
				focus: "睡眠和补给",
				sleep_target_hours: "7-9",
				adjustment_trigger: "疼痛降量",
			},
			is_completed: false,
			summary: null,
		},
	],
	weeks: [
		{
			week_index: 1,
			week_start: "2026-08-10",
			phase_name: "base" as const,
			target_weekly_km_low: 70,
			target_weekly_km_high: 80,
			key_sessions: [],
			is_recovery_week: false,
		},
	],
	training_principles: ["循序渐进"],
	generated_by: "coach_agent" as const,
	version: 1 as const,
	created_at: "2026-08-09T00:00:00Z",
	updated_at: "2026-08-09T00:00:00Z",
};

const weeklyPlan = {
	schema: "weekly-plan/v1" as const,
	week_name: "2026-06-15_06-21",
	sessions: [
		{
			schema: "plan-session/v1" as const,
			date: "2026-06-15",
			session_index: 0,
			summary: "休息",
			notes_md: null,
			total_distance_m: null,
			total_duration_s: null,
			estimated_dose: null,
			kind: "rest",
			spec: null,
		},
	],
	nutrition: Array.from({ length: 7 }, (_, index) => {
		const date = `2026-06-${String(15 + index).padStart(2, "0")}`;
		return {
			schema: "plan-nutrition/v1" as const,
			date,
			kcal_target: null,
			carbs_g: null,
			protein_g: null,
			fat_g: null,
			water_ml: null,
			meals: [],
			notes_md: "按饥饿感正常进食",
		};
	}),
	notes_md: null,
	coach_notes: null,
};

function directResponse(content: unknown): string {
	return JSON.stringify({ disposition: "return_direct", content });
}

test("orchestrator extracts a validated master plan from its direct envelope", () => {
	const content = JSON.stringify(masterPlan);
	const result = getMasterPlanTaskResult([
		{
			type: "ai",
			tool_calls: [
				{
					id: "task-1",
					name: "task",
					args: { subagent_type: "generate_master_plan" },
				},
			],
		},
		{
			type: "tool",
			name: "task",
			tool_call_id: "task-1",
			content: directResponse(masterPlan),
		},
	]);

	assert.equal(result, content);
});

test("orchestrator extracts a validated weekly plan from its direct envelope", () => {
	const result = getDirectPlanTaskResult(
		[
			{
				type: "ai",
				tool_calls: [
					{
						id: "task-1",
						name: "task",
						args: { subagent_type: "generate_weekly_plan" },
					},
				],
			},
			{
				type: "tool",
				name: "task",
				tool_call_id: "task-1",
				content: directResponse(weeklyPlan),
			},
		],
		"2026-06-15",
	);

	assert.equal(result, JSON.stringify(weeklyPlan));
});

test("orchestrator rejects an invalid weekly-plan direct envelope", () => {
	const result = getDirectPlanTaskResult(
		[
			{
				type: "ai",
				tool_calls: [
					{
						id: "task-1",
						name: "task",
						args: { subagent_type: "generate_weekly_plan" },
					},
				],
			},
			{
				type: "tool",
				name: "task",
				tool_call_id: "task-1",
				content: directResponse({ sessions: [] }),
			},
		],
		"2026-06-15",
	);

	assert.equal(result, undefined);
});

test("passthrough middleware skips the model only for a direct envelope", async () => {
	const middleware = createPlanPassthroughMiddleware();
	const wrapModelCall = middleware.wrapModelCall;
	assert.ok(wrapModelCall);

	let handlerCalls = 0;
	const fallback = new AIMessage("fallback");
	const handler = async () => {
		handlerCalls += 1;
		return fallback;
	};
	const taskCall = new AIMessage({
		content: "",
		tool_calls: [
			{
				id: "task-1",
				name: "task",
				args: { subagent_type: "generate_master_plan" },
				type: "tool_call",
			},
		],
	});
	const runtime = { context: { asof: "2026-06-10" } } as never;
	const direct = await wrapModelCall(
		{
			messages: [
				taskCall,
				new ToolMessage({
					content: directResponse(masterPlan),
					tool_call_id: "task-1",
				}),
			],
			runtime,
		} as never,
		handler,
	);
	assert.equal(handlerCalls, 0);
	assert.ok(AIMessage.isInstance(direct));
	assert.equal(direct.content, JSON.stringify(masterPlan));

	const weeklyTaskCall = new AIMessage({
		content: "",
		tool_calls: [
			{
				id: "weekly-task",
				name: "task",
				args: { subagent_type: "generate_weekly_plan" },
				type: "tool_call",
			},
		],
	});
	const weeklyDirect = await wrapModelCall(
		{
			messages: [
				weeklyTaskCall,
				new ToolMessage({
					content: directResponse(weeklyPlan),
					tool_call_id: "weekly-task",
				}),
			],
			runtime,
		} as never,
		handler,
	);
	assert.equal(handlerCalls, 0);
	assert.ok(AIMessage.isInstance(weeklyDirect));
	assert.equal(weeklyDirect.content, JSON.stringify(weeklyPlan));

	const readerTaskCall = new AIMessage({
		content: "",
		tool_calls: [
			{
				id: "reader-task",
				name: "task",
				args: { subagent_type: "weekly_plan" },
				type: "tool_call",
			},
		],
	});
	const readerResult = await wrapModelCall(
		{
			messages: [
				readerTaskCall,
				new ToolMessage({
					content: directResponse(weeklyPlan),
					tool_call_id: "reader-task",
				}),
			],
			runtime,
		} as never,
		handler,
	);
	assert.equal(handlerCalls, 1);
	assert.equal(readerResult, fallback);

	const delegated = await wrapModelCall(
		{
			messages: [
				taskCall,
				new ToolMessage({
					content: JSON.stringify({ disposition: "continue" }),
					tool_call_id: "task-1",
				}),
			],
			runtime,
		} as never,
		handler,
	);
	assert.equal(handlerCalls, 2);
	assert.equal(delegated, fallback);
});

test("orchestrator forwards the runtime task result when ToolMessage omits name", () => {
	const content = JSON.stringify(masterPlan);
	const result = getMasterPlanTaskResult([
		new AIMessage({
			content: "",
			tool_calls: [
				{
					id: "task-1",
					name: "task",
					args: { subagent_type: "generate_master_plan" },
					type: "tool_call",
				},
			],
		}),
		new ToolMessage({
			content: directResponse(masterPlan),
			tool_call_id: "task-1",
		}),
	]);

	assert.equal(result, content);
});

test("orchestrator forwards the envelope content without revalidating it", () => {
	const plan = { ...masterPlan, total_weeks: 2 };
	const content = JSON.stringify(plan);
	const result = getMasterPlanTaskResult([
		{
			type: "ai",
			tool_calls: [
				{
					id: "task-1",
					name: "task",
					args: { subagent_type: "generate_master_plan" },
				},
			],
		},
		{
			type: "tool",
			tool_call_id: "task-1",
			content: directResponse(plan),
		},
	]);

	assert.equal(result, content);
});

test("orchestrator does not bypass the model for unrelated or invalid task results", () => {
	assert.equal(
		getMasterPlanTaskResult([
			{
				type: "ai",
				tool_calls: [
					{ id: "task-1", name: "task", args: { subagent_type: "qa" } },
				],
			},
			{
				type: "tool",
				name: "task",
				tool_call_id: "task-1",
				content: directResponse(masterPlan),
			},
		]),
		undefined,
	);
	assert.equal(
		getMasterPlanTaskResult([
			{
				type: "ai",
				tool_calls: [
					{
						id: "task-1",
						name: "task",
						args: { subagent_type: "generate_master_plan" },
					},
				],
			},
			{
				type: "tool",
				name: "task",
				tool_call_id: "task-1",
				content: "not JSON",
			},
		]),
		undefined,
	);
	assert.equal(
		getMasterPlanTaskResult([
			{
				type: "ai",
				tool_calls: [
					{
						id: "task-1",
						name: "task",
						args: { subagent_type: "generate_master_plan" },
					},
				],
			},
			{
				type: "tool",
				tool_call_id: "task-1",
				content: JSON.stringify({
					disposition: "continue",
					content: masterPlan,
				}),
			},
		]),
		undefined,
	);
	assert.equal(
		getMasterPlanTaskResult([
			{
				type: "ai",
				tool_calls: [
					{
						id: "task-1",
						name: "task",
						args: { subagent_type: "generate_master_plan" },
					},
				],
			},
			{
				type: "tool",
				status: "error",
				tool_call_id: "task-1",
				content: directResponse(masterPlan),
			},
		]),
		undefined,
	);
	assert.equal(
		getMasterPlanTaskResult([
			{
				type: "ai",
				tool_calls: [
					{
						id: "task-1",
						name: "task",
						args: { subagent_type: "generate_master_plan" },
					},
				],
			},
			{
				type: "tool",
				tool_call_id: "task-1",
				content: '{"error":"generation_failed"}',
			},
		]),
		undefined,
	);
	assert.equal(
		getMasterPlanTaskResult([
			{
				type: "ai",
				tool_calls: [
					{
						id: "task-1",
						name: "task",
						args: { subagent_type: "generate_master_plan" },
					},
				],
			},
			{
				type: "tool",
				tool_call_id: "task-1",
				content: JSON.stringify({ disposition: "return_direct" }),
			},
		]),
		undefined,
	);
	assert.equal(
		getMasterPlanTaskResult([
			{
				type: "ai",
				tool_calls: [
					{
						id: "task-1",
						name: "task",
						args: { subagent_type: "generate_master_plan" },
					},
				],
			},
			{
				type: "tool",
				tool_call_id: "task-1",
				content: JSON.stringify({
					disposition: "return_direct",
					content: [],
				}),
			},
		]),
		undefined,
	);
});

test("orchestrator only forwards an immediately preceding generator task result", () => {
	const content = JSON.stringify(masterPlan);
	assert.equal(
		getMasterPlanTaskResult([
			{
				type: "ai",
				tool_calls: [
					{
						id: "old-task",
						name: "task",
						args: { subagent_type: "generate_master_plan" },
					},
				],
			},
			{ type: "tool", name: "task", tool_call_id: "old-task", content },
			{ type: "human", content: "解释一下这个计划" },
		]),
		undefined,
	);
});

test("orchestrator does not replay a generator result after a later tool call", () => {
	const content = JSON.stringify(masterPlan);
	assert.equal(
		getMasterPlanTaskResult([
			{
				type: "ai",
				tool_calls: [
					{
						id: "generator-task",
						name: "task",
						args: { subagent_type: "generate_master_plan" },
					},
				],
			},
			{ type: "tool", name: "task", tool_call_id: "generator-task", content },
			{
				type: "ai",
				tool_calls: [{ id: "memory", name: "remember_athlete_fact", args: {} }],
			},
			{
				type: "tool",
				name: "remember_athlete_fact",
				tool_call_id: "memory",
				content: "已记住",
			},
		]),
		undefined,
	);
});

test("all athlete-facing subagents expose PB and running-calibration tools", () => {
	const store = new StrideDataStore({} as never);
	const subagents = [
		getQaSubagent(store, modelConfig),
		getCoachSubagent(store, modelConfig),
		getMasterPlanSubagent(store, modelConfig),
	];

	for (const subagent of subagents) {
		const toolNames = subagent.tools.map((tool) => tool.name);
		assert.ok(
			toolNames.includes("get_personal_bests"),
			`${subagent.name} lacks PB tool`,
		);
		assert.ok(
			toolNames.includes("get_running_calibration"),
			`${subagent.name} lacks calibration tool`,
		);
	}
});
