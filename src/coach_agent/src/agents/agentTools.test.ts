import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { ModelConfig } from "../config/config.js";
import { StrideDataStore } from "../persistence/index.js";
import {
	getMasterPlanGeneratorSubagent,
	getMasterPlanSubagent,
} from "./master_plan/agent.js";
import { MasterPlanSchema } from "./master_plan/schema.js";
import { getMasterPlanTaskResult } from "./masterPlanPassthrough.js";
import { MASTER_PLAN_PROMPT } from "./prompts.js";
import { getQaSubagent } from "./qa/agent.js";
import { getCoachSubagent } from "./weekly_plan/agent.js";

const modelConfig: ModelConfig = {
	name: "test",
	provider: "openai-compatible",
	model: "test-model",
	deployment: "test",
	endpoint: "http://127.0.0.1:1",
	auth: "api-key",
	api_kind: "responses",
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
	assert.match(MASTER_PLAN_PROMPT, /暂停并等待用户回答/);
});

test("master-plan agent has a machine-enforced structured output contract", () => {
	assert.match(MASTER_PLAN_PROMPT, /结构化输出/);
	const store = new StrideDataStore({} as never);
	const generator = getMasterPlanGeneratorSubagent(store, modelConfig);
	const reader = getMasterPlanSubagent(store, modelConfig);
	assert.equal(generator.responseFormat, MasterPlanSchema);
	assert.equal(reader.responseFormat, undefined);
	assert.ok(generator.skills.includes("/generate-master-plan/"));
	assert.ok(!reader.skills.includes("/generate-master-plan/"));
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
			name: "基础期" as const,
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
			phase_name: "基础期" as const,
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

test("orchestrator forwards a validated master-plan task result byte-for-byte", () => {
	const content = JSON.stringify(masterPlan, null, 2);
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
		{ type: "tool", name: "task", tool_call_id: "task-1", content },
	]);

	assert.equal(result, content);
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
		new ToolMessage({ content, tool_call_id: "task-1" }),
	]);

	assert.equal(result, content);
});

test("orchestrator forwards a structurally complete plan with semantic issues", () => {
	const content = JSON.stringify({ ...masterPlan, total_weeks: 2 });
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
		{ type: "tool", tool_call_id: "task-1", content },
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
				content: JSON.stringify(masterPlan),
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
				content: "[]",
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
				content: JSON.stringify(masterPlan),
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
				content: JSON.stringify({
					status: "draft",
					generated_by: "coach_agent",
					goal: {},
					phases: [],
					weeks: [],
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
				tool_call_id: "task-1",
				content: JSON.stringify({
					...masterPlan,
					goal: { ...masterPlan.goal, race_date: "2026-02-30" },
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
