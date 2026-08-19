import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import * as z from "zod";
import type { WeeklyPlan } from "../../agents/weekly_plan/schema.js";
import type { ModelConfig } from "../../config/config.js";
import type {
	DailyRecovery,
	WeeklyPlanContext,
} from "../../persistence/index.js";
import type { TargetTrainingLoad } from "./contracts.js";
import {
	createWeeklyPlanLlm,
	loadWeeklyPlanPromptAssets,
	runToolLoop,
	SCHEMA_TOOL_NAME,
	SIMULATION_TOOL_NAME,
	validateGeneratedWeeklyPlan,
	weeklyPlanPrompt,
} from "./llm.js";

const MODEL: ModelConfig = {
	name: "test-responses",
	provider: "openai-compatible",
	model: "test-model",
	deployment: "test-model",
	endpoint: "http://127.0.0.1:1/v1",
	auth: "api-key",
	api_kind: "responses",
	max_tokens: 1024,
	timeout_s: 1,
};

function recoveryHistory(): DailyRecovery[] {
	return Array.from({ length: 14 }, (_, index) => ({
		date: `2026-08-${String(index + 1).padStart(2, "0")}`,
		rhr: 50,
		hrv: 60,
	}));
}

function weeklyContext(): WeeklyPlanContext {
	return {
		as_of: "2026-08-16",
		plan_start: "2026-08-17",
		week_name: "2026-08-17_08-23",
		lookback: { start_date: "2026-07-18", end_date: "2026-08-14", days: 28 },
		user_profile: {
			age: 47,
			weight_kg: 68,
			threshold_pace_s_per_km: 250,
			threshold_speed_mps: 4,
			lactate_threshold_hr: 170,
			rhr_baseline: 50,
			heart_rate_zones: [],
			pace_zones: [],
		},
		training_position: {
			phase: { name: "build" },
			stage: {
				week_index: 0,
				week_start: "2026-08-17",
				phase_name: "build",
				is_recovery_week: false,
				target_weekly_km_low: 30,
				target_weekly_km_high: 45,
				key_sessions: [],
			},
		},
		recent_activities: [],
		recent_training_weeks: [],
		absorbed_load: {
			complete_weeks_considered: [],
			distance_anchor_km: 50,
			latest_complete_week: null,
		},
		recent_feedback: [],
		fitness_state: {
			as_of_date: "2026-08-16",
			stride_training_load: {
				available: true,
				acute_load: 55,
				chronic_load: 50,
				form: 5,
				load_ratio: 1.0,
			},
			trend: [],
			provenance: { source: "stride", vendor_derived: false },
		},
		injury: [],
		recovery: {
			latest: null,
			seven_day_average: { rhr: 50, hrv: 60 },
			history: recoveryHistory(),
			provenance: { source: "raw_health_measurements" },
		},
	} as unknown as WeeklyPlanContext;
}

function targetTrainingLoad(): TargetTrainingLoad {
	return {
		available: true,
		missing_reason: null,
		load_decision: "maintain",
		training_load_low: 400,
		training_load_high: 432,
		target_distance_km_low: null,
		target_distance_km_high: null,
		load_ratio_low: 1.1,
		load_ratio_high: 1.14,
		remove_quality_stimulus: false,
		details: {
			last_complete_week: null,
			anchor: { training_load_avg4w: 400, distance_km_avg4w: 50 },
			trend: {
				recovery: null,
				rhr: {},
				hrv: {},
				seven_day_average: { rhr: 50, hrv: 60 },
				current_load_ratio: 1.0,
				form: 5,
				is_recovery_week: false,
				recovery_week_overridden: false,
				activity_restricted: false,
				recent_high_cost_training: false,
			},
			rationale: [],
		},
	};
}

function weeklyPlan(): WeeklyPlan {
	return {
		schema: "weekly-plan/v1",
		week_name: "2026-08-17_08-23",
		sessions: [
			{
				schema: "plan-session/v1",
				kind: "run",
				date: "2026-08-17",
				session_index: 0,
				summary: "easy run",
				notes_md: null,
				total_distance_m: 8000,
				total_duration_s: 2700,
				estimated_dose: null,
				spec: {
					schema: "run-workout/v1",
					name: "easy run",
					date: "2026-08-17",
					note: null,
					blocks: [
						{
							repeat: 1,
							steps: [
								{
									step_kind: "work",
									duration: { kind: "open", value: null },
									target: { kind: "open", low: null, high: null },
									note: null,
									hr_cap_bpm: null,
								},
							],
						},
					],
				},
			},
			{
				schema: "plan-session/v1",
				kind: "rest",
				date: "2026-08-18",
				session_index: 0,
				summary: "rest day",
				notes_md: null,
				total_distance_m: null,
				total_duration_s: null,
				estimated_dose: null,
				spec: null,
			},
		],
		nutrition: Array.from({ length: 7 }, (_, index) => ({
			schema: "plan-nutrition/v1",
			date: `2026-08-${String(17 + index).padStart(2, "0")}`,
			kcal_target: 2000,
			carbs_g: 250,
			protein_g: 120,
			fat_g: 60,
			water_ml: 2000,
			meals: [],
			notes_md: null,
		})),
		notes_md: null,
		coach_notes: "test plan",
	};
}

function llmInput() {
	return {
		phase: "build" as const,
		weeklyContext: weeklyContext(),
		targetTrainingLoad: targetTrainingLoad(),
	};
}

test("loadWeeklyPlanPromptAssets loads the skill and every phase reference", async () => {
	const assets = await loadWeeklyPlanPromptAssets();
	assert.match(assets.skill, /# 生成每周训练计划/);
	assert.match(assets.skill, /`base` → `references\/base\.md`/);
	for (const phase of [
		"base",
		"build",
		"speed",
		"marathon",
		"taper",
		"recovery",
	] as const) {
		assert.ok(
			assets.references[phase].length > 0,
			`reference for ${phase} should be non-empty`,
		);
	}
});

test("weeklyPlanPrompt keeps static doctrine in system and runtime data in user", async () => {
	const assets = await loadWeeklyPlanPromptAssets();
	const messages = weeklyPlanPrompt(llmInput(), assets);
	const system = messages[0][1];
	const user = messages[1][1];

	assert.ok(system.startsWith(assets.skill));
	assert.ok(system.includes("# 阶段参考：build"));
	assert.ok(system.includes(assets.references.build));

	const userPayload = JSON.parse(user);
	assert.equal(userPayload.week_name, "2026-08-17_08-23");
	assert.equal(userPayload.plan_start, "2026-08-17");
	assert.equal(userPayload.training_position.stage.phase_name, "build");
	assert.equal(userPayload.target_training_load.load_decision, "maintain");
	assert.equal(userPayload.absorbed_load.distance_anchor_km, 50);
	assert.equal(userPayload.recovery.history.length, 14);
});

test("validateGeneratedWeeklyPlan accepts a plan with a rest day and run within the cap", () => {
	const plan = weeklyPlan();
	assert.equal(validateGeneratedWeeklyPlan(plan, llmInput()), plan);
});

test("validateGeneratedWeeklyPlan rejects a plan without an explicit rest day", () => {
	const plan = weeklyPlan();
	plan.sessions = plan.sessions.filter((session) => session.kind !== "rest");
	assert.throws(
		() => validateGeneratedWeeklyPlan(plan, llmInput()),
		/no explicit rest day/,
	);
});

test("validateGeneratedWeeklyPlan rejects a plan without any run session", () => {
	const plan = weeklyPlan();
	plan.sessions = plan.sessions.filter((session) => session.kind !== "run");
	assert.throws(
		() => validateGeneratedWeeklyPlan(plan, llmInput()),
		/no run session/,
	);
});

test("validateGeneratedWeeklyPlan rejects total run distance above the anchor cap", () => {
	const plan = weeklyPlan();
	const run = plan.sessions.find((session) => session.kind === "run");
	if (run === undefined) {
		throw new Error("test invariant: plan must contain a run session");
	}
	run.total_distance_m = 56_000;
	assert.throws(
		() => validateGeneratedWeeklyPlan(plan, llmInput()),
		/exceeds the 55\.0 km cap/,
	);
});

test("createWeeklyPlanLlm exposes an invoke that returns the parsed plan", async () => {
	const llm = await createWeeklyPlanLlm({ weeklyPlanModel: MODEL });
	assert.equal(typeof llm.invoke, "function");
});

function fakeSimulationTool() {
	return tool(async () => ({ total_dose: 96, available: true }), {
		name: SIMULATION_TOOL_NAME,
		description: "test simulation tool",
		schema: z.strictObject({ plan: z.any() }),
	});
}

function schemaToolCall(plan: WeeklyPlan) {
	return {
		id: "call-schema",
		name: SCHEMA_TOOL_NAME,
		args: JSON.stringify({ disposition: "return_direct", content: plan }),
		type: "tool_call" as const,
	};
}

test("runToolLoop accepts the schema call immediately", async () => {
	const plan = weeklyPlan();
	const result = await runToolLoop({
		invoke: async () =>
			new AIMessage({
				content: "",
				tool_calls: [schemaToolCall(plan) as never],
			}),
		simulationTool: fakeSimulationTool(),
		schemaToolName: SCHEMA_TOOL_NAME,
		maxIterations: 4,
		validate: (direct) => direct.content,
	});
	assert.deepEqual(result, plan);
});

test("runToolLoop executes simulation tool calls before the schema call", async () => {
	const plan = weeklyPlan();
	let simulated = 0;
	const simulationTool = tool(
		async () => {
			simulated += 1;
			return { total_dose: 96, available: true };
		},
		{
			name: SIMULATION_TOOL_NAME,
			description: "test simulation tool",
			schema: z.strictObject({ plan: z.any() }),
		},
	);
	let round = 0;
	const result = await runToolLoop({
		invoke: async (messages) => {
			round += 1;
			if (round === 1) {
				assert.equal(messages.length, 0);
				return new AIMessage({
					content: "",
					tool_calls: [
						{
							id: "call-sim",
							name: SIMULATION_TOOL_NAME,
							args: JSON.stringify({ plan }),
							type: "tool_call",
						} as never,
					],
				});
			}
			assert.equal(messages.length, 2);
			assert.ok(AIMessage.isInstance(messages[0]));
			assert.ok(ToolMessage.isInstance(messages[1]));
			return new AIMessage({
				content: "",
				tool_calls: [schemaToolCall(plan) as never],
			});
		},
		simulationTool,
		schemaToolName: SCHEMA_TOOL_NAME,
		maxIterations: 4,
		validate: (direct) => direct.content,
	});
	assert.equal(simulated, 1);
	assert.deepEqual(result, plan);
});

test("runToolLoop feeds schema failures back as a tool message", async () => {
	let round = 0;
	await runToolLoop({
		invoke: async () => {
			round += 1;
			if (round === 1) {
				return new AIMessage({
					content: "",
					tool_calls: [
						{
							id: "call-bad",
							name: SCHEMA_TOOL_NAME,
							args: JSON.stringify({
								disposition: "return_direct",
								content: { ...weeklyPlan(), week_name: 42 },
							}),
							type: "tool_call",
						} as never,
					],
				});
			}
			return new AIMessage({
				content: "",
				tool_calls: [schemaToolCall(weeklyPlan()) as never],
			});
		},
		simulationTool: fakeSimulationTool(),
		schemaToolName: SCHEMA_TOOL_NAME,
		maxIterations: 4,
		validate: (direct) => direct.content,
	});
	assert.equal(round, 2);
});

test("runToolLoop rejects unknown tool calls", async () => {
	await assert.rejects(
		() =>
			runToolLoop({
				invoke: async () =>
					new AIMessage({
						content: "",
						tool_calls: [
							{
								id: "call-x",
								name: "other_tool",
								args: "{}",
								type: "tool_call",
							},
						],
					} as never),
				simulationTool: fakeSimulationTool(),
				schemaToolName: SCHEMA_TOOL_NAME,
				maxIterations: 4,
				validate: (direct) => direct.content,
			}),
		/unexpected tool call/,
	);
});

test("runToolLoop fails when the model never submits the schema call", async () => {
	await assert.rejects(
		() =>
			runToolLoop({
				invoke: async () =>
					new AIMessage({
						content: "",
						tool_calls: [
							{
								id: "call-sim",
								name: SIMULATION_TOOL_NAME,
								args: JSON.stringify({ plan: weeklyPlan() }),
								type: "tool_call",
							},
						],
					} as never),
				simulationTool: fakeSimulationTool(),
				schemaToolName: SCHEMA_TOOL_NAME,
				maxIterations: 2,
				validate: (direct) => direct.content,
			}),
		/did not converge/,
	);
});
