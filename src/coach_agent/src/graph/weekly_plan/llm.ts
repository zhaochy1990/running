import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AIMessage,
	type BaseMessage,
	SystemMessage,
	ToolMessage,
} from "@langchain/core/messages";
import { type StructuredTool, tool } from "@langchain/core/tools";
import * as z from "zod";
import { buildResponsesModel } from "../../agents/common.js";
import {
	type WeeklyPlan,
	WeeklyPlanDirectResponseSchema,
	WeeklyPlanSchema,
} from "../../agents/weekly_plan/schema.js";
import type { ModelConfig } from "../../config/config.js";
import type { WeeklyPlanContext } from "../../persistence/index.js";
import { ModelContractError } from "../master_plan/nodes.js";
import type { PhaseName, TargetTrainingLoad } from "./contracts.js";
import { simulateWeeklyPlanLoad } from "./simulation.js";

export interface WeeklyPlanLlmInput {
	phase: PhaseName;
	weeklyContext: WeeklyPlanContext;
	targetTrainingLoad: TargetTrainingLoad;
	/** Feedback from the previous generation attempt that failed load validation. */
	previousSimulation?: {
		attempt: number;
		total_dose: number | null;
		target_training_load_low: number | null;
		target_training_load_high: number | null;
	} | null;
}

export interface WeeklyPlanLlm {
	invoke(input: WeeklyPlanLlmInput): Promise<WeeklyPlan>;
}

export interface WeeklyPlanLlmOptions {
	weeklyPlanModel: ModelConfig;
	/** Cap on tool-call rounds inside one generation (default 8). */
	maxToolIterations?: number;
}

interface WeeklyPlanPromptAssets {
	skill: string;
	references: Record<PhaseName, string>;
}

const PHASE_REFERENCE_FILES: Record<PhaseName, string> = {
	base: "base.md",
	build: "build.md",
	speed: "speed.md",
	marathon: "marathon.md",
	taper: "taper.md",
	recovery: "recovery.md",
};

export const SCHEMA_TOOL_NAME = "generate_weekly_plan";
export const SIMULATION_TOOL_NAME = "simulate_weekly_plan_load";

const simulatePlanInputSchema = z.strictObject({
	plan: WeeklyPlanSchema,
});

export async function loadWeeklyPlanPromptAssets(): Promise<WeeklyPlanPromptAssets> {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const skillsDir = resolve(moduleDir, "../../skills/generate-weekly-plan");
	const skill = await readFile(resolve(skillsDir, "SKILL.md"), "utf8");
	const references: Record<PhaseName, string> = {} as Record<PhaseName, string>;
	for (const [phase, file] of Object.entries(PHASE_REFERENCE_FILES)) {
		references[phase as PhaseName] = await readFile(
			resolve(skillsDir, "references", file),
			"utf8",
		);
	}
	return { skill, references };
}

type PromptMessage = ["system" | "user", string];

export function weeklyPlanPrompt(
	input: WeeklyPlanLlmInput,
	assets: WeeklyPlanPromptAssets,
): [PromptMessage, PromptMessage] {
	const retryHint =
		input.previousSimulation === null || input.previousSimulation === undefined
			? ""
			: `

上一轮生成未通过负荷校验，根据以下模拟反馈重新生成并再次验证：
- 第 ${input.previousSimulation.attempt} 次生成：周总预估负荷 ${formatDose(input.previousSimulation.total_dose)}；
- 目标周总负荷区间 ${formatDose(input.previousSimulation.target_training_load_low)} ~ ${formatDose(input.previousSimulation.target_training_load_high)}（±10% 容差）；
- 调整训练安排使周总预估负荷进入目标区间，先调用 ${SIMULATION_TOOL_NAME} 验证，达标后再提交 ${SCHEMA_TOOL_NAME}。`;
	return [
		[
			"system",
			`${assets.skill}\n\n# 阶段参考：${input.phase}\n\n${assets.references[input.phase]}\n\n你必须先用 ${SIMULATION_TOOL_NAME} 模拟候选计划，验证周总负荷落在目标区间（±10% 容差）后再调用 ${SCHEMA_TOOL_NAME} 提交最终计划。`,
		],
		[
			"user",
			`${JSON.stringify(weeklyPlanUserPayload(input), null, 2)}\n${retryHint}`,
		],
	];
}

function formatDose(value: number | null | undefined): string {
	return value === null || value === undefined
		? "n/a"
		: String(Math.round(value));
}

function weeklyPlanUserPayload(
	input: WeeklyPlanLlmInput,
): Record<string, unknown> {
	const { weeklyContext, targetTrainingLoad } = input;
	return {
		plan_start: weeklyContext.plan_start,
		week_name: weeklyContext.week_name,
		training_position: weeklyContext.training_position,
		target_training_load: targetTrainingLoad,
		absorbed_load: weeklyContext.absorbed_load,
		fitness_state: weeklyContext.fitness_state,
		injury: weeklyContext.injury,
		recent_training_weeks: weeklyContext.recent_training_weeks.slice(-4),
		recovery: {
			seven_day_average: weeklyContext.recovery.seven_day_average,
			history: weeklyContext.recovery.history.slice(-14),
		},
	};
}

export function validateGeneratedWeeklyPlan(
	plan: WeeklyPlan,
	input: WeeklyPlanLlmInput,
): WeeklyPlan {
	const hasRestDay = plan.sessions.some((session) => session.kind === "rest");
	if (!hasRestDay) {
		throw new Error("weekly plan has no explicit rest day");
	}
	const hasRunSession = plan.sessions.some((session) => session.kind === "run");
	if (!hasRunSession) {
		throw new Error("weekly plan has no run session");
	}
	const totalRunMeters = plan.sessions
		.filter((session) => session.kind === "run")
		.reduce((total, session) => total + (session.total_distance_m ?? 0), 0);
	const stage = record(input.weeklyContext.training_position.stage);
	const targetKmHigh = number(stage?.target_weekly_km_high);
	const anchorKm = number(
		input.weeklyContext.absorbed_load?.distance_anchor_km,
	);
	const capKm = Math.max(targetKmHigh ?? 0, anchorKm ?? 0) * 1.1;
	if (capKm > 0 && totalRunMeters / 1000 > capKm) {
		throw new Error(
			`weekly plan total run distance ${(totalRunMeters / 1000).toFixed(1)} km exceeds the ${capKm.toFixed(1)} km cap`,
		);
	}
	return plan;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Build the deterministic load-simulation tool bound to one loaded context. */
export function createSimulationTool(weeklyContext: WeeklyPlanContext) {
	return tool(
		async (input: z.infer<typeof simulatePlanInputSchema>) =>
			simulateWeeklyPlanLoad(input.plan, weeklyContext),
		{
			name: SIMULATION_TOOL_NAME,
			description:
				"Deterministically estimate every run session's STRIDE training dose and project daily CTL, ATL, Form, and load ratio for one complete candidate WeeklyPlan. Call this with the final candidate before returning it.",
			schema: simulatePlanInputSchema,
		},
	);
}

function toolCallArgs(call: { args: unknown }): Record<string, unknown> {
	if (typeof call.args === "string") {
		return JSON.parse(call.args) as Record<string, unknown>;
	}
	return call.args as Record<string, unknown>;
}

export interface ToolLoopDeps {
	/** Model callable that may return tool calls; test seam. */
	invoke: (messages: BaseMessage[]) => Promise<AIMessage>;
	simulationTool: StructuredTool;
	schemaToolName: string;
	maxIterations: number;
	/** System/user prompt messages prepended to the tool-call history. */
	initialMessages?: BaseMessage[];
	validate: (
		direct: z.infer<typeof WeeklyPlanDirectResponseSchema>,
	) => WeeklyPlan;
}

/** Drive a tool-calling loop: execute simulate calls, accept the schema call. */
export async function runToolLoop(deps: ToolLoopDeps): Promise<WeeklyPlan> {
	const messages: BaseMessage[] = [...(deps.initialMessages ?? [])];
	for (let attempt = 1; attempt <= deps.maxIterations; attempt++) {
		const response = await deps.invoke(messages);
		const calls = response.tool_calls ?? [];
		const workCalls = calls.filter((call) => call.name !== deps.schemaToolName);
		if (workCalls.length > 0) {
			messages.push(response);
			for (const call of workCalls) {
				if (call.name !== deps.simulationTool.name) {
					throw new ModelContractError(
						`unexpected tool call "${call.name}" in weekly plan generation`,
					);
				}
				let observation: unknown;
				try {
					observation = await deps.simulationTool.invoke(toolCallArgs(call));
				} catch (error) {
					observation = {
						error: error instanceof Error ? error.message : "tool failed",
					};
				}
				messages.push(
					new ToolMessage({
						content: JSON.stringify(observation),
						tool_call_id: call.id ?? "",
					}),
				);
			}
			continue;
		}
		const schemaCall = calls.find((call) => call.name === deps.schemaToolName);
		if (schemaCall === undefined) {
			throw new ModelContractError(
				"weekly plan model returned neither a tool call nor the schema call",
			);
		}
		try {
			const direct = WeeklyPlanDirectResponseSchema.parse(
				toolCallArgs(schemaCall),
			);
			return deps.validate(direct);
		} catch (error) {
			const detail =
				error instanceof Error ? error.message : "invalid contract";
			messages.push(response);
			messages.push(
				new ToolMessage({
					content: `Invalid weekly plan submission: ${detail}. Fix the plan and submit again.`,
					tool_call_id: schemaCall.id ?? "",
				}),
			);
		}
	}
	throw new ModelContractError(
		`weekly plan generation did not converge after ${deps.maxIterations} tool-call rounds`,
	);
}

export async function createWeeklyPlanLlm({
	weeklyPlanModel,
	maxToolIterations = 8,
}: WeeklyPlanLlmOptions): Promise<WeeklyPlanLlm> {
	const assets = await loadWeeklyPlanPromptAssets();
	return {
		async invoke(input) {
			const simulationTool = createSimulationTool(input.weeklyContext);
			const model = buildResponsesModel(weeklyPlanModel).bindTools(
				[
					simulationTool,
					{
						name: SCHEMA_TOOL_NAME,
						description:
							"Submit the final complete weekly plan. Call this only after simulate_weekly_plan_load reports a total dose within the target load range.",
						schema: WeeklyPlanDirectResponseSchema as never,
					},
				],
				{ tool_choice: "required" },
			);
			const [systemMessage, userMessage] = weeklyPlanPrompt(input, assets);
			return runToolLoop({
				invoke: (history) => model.invoke(history),
				simulationTool,
				schemaToolName: SCHEMA_TOOL_NAME,
				maxIterations: maxToolIterations,
				initialMessages: [
					new SystemMessage(systemMessage[1]),
					new AIMessage({ content: userMessage[1] }),
				],
				validate: (direct) =>
					validateGeneratedWeeklyPlan(direct.content, input),
			});
		},
	};
}
