import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type WeeklyPlan,
	WeeklyPlanDirectResponseSchema,
} from "../../agents/weekly_plan/schema.js";
import type { ModelConfig } from "../../config/config.js";
import type { WeeklyPlanContext } from "../../persistence/index.js";
import {
	invokeStructured,
	type PromptMessage,
} from "../master_plan/llm/structured.js";
import type { PhaseName, TargetTrainingLoad } from "./contracts.js";

export interface WeeklyPlanLlmInput {
	phase: PhaseName;
	weeklyContext: WeeklyPlanContext;
	targetTrainingLoad: TargetTrainingLoad;
}

export interface WeeklyPlanLlm {
	invoke(input: WeeklyPlanLlmInput): Promise<WeeklyPlan>;
}

export interface WeeklyPlanLlmOptions {
	weeklyPlanModel: ModelConfig;
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

export function weeklyPlanPrompt(
	input: WeeklyPlanLlmInput,
	assets: WeeklyPlanPromptAssets,
): [PromptMessage, PromptMessage] {
	return [
		[
			"system",
			`${assets.skill}\n\n# 阶段参考：${input.phase}\n\n${assets.references[input.phase]}`,
		],
		["user", JSON.stringify(weeklyPlanUserPayload(input), null, 2)],
	];
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

export async function createWeeklyPlanLlm({
	weeklyPlanModel,
}: WeeklyPlanLlmOptions): Promise<WeeklyPlanLlm> {
	const assets = await loadWeeklyPlanPromptAssets();
	return {
		async invoke(input) {
			return invokeStructured(
				weeklyPlanModel,
				WeeklyPlanDirectResponseSchema,
				"generate_weekly_plan",
				weeklyPlanPrompt(input, assets),
				(direct) => {
					validateGeneratedWeeklyPlan(direct.content, input);
					return direct;
				},
			).then((direct) => direct.content);
		},
	};
}
