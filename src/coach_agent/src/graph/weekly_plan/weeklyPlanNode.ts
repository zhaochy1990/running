import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { getLogger } from "@stride/common";
import { type PhaseName, type TargetTrainingLoad, type WeeklyPlan, WeeklyPlanGenerationSchema, WeeklyPlanSchema } from "@stride/contract";
import { buildResponsesModel } from "../../agents/common.js";
import type { ModelConfig } from "../../config/config.js";
import type { WeeklyPlanContext } from "../../data/weeklyPlanContextProvider.js";
import { ModelContractError } from "../master_plan/nodes.js";
import { acceptedLoadBand } from "./loadTolerance.js";
import { GENERATE_WEEKLY_PLAN_SYSTEM_PROMPT } from "./prompt.js";

const logger = getLogger("weekly-plan-llm");

export interface WeeklyPlanLLM {
  invoke(input: WeeklyPlanLlmInput): Promise<WeeklyPlan>;
}

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

class WeeklyPlanLLMImplementation implements WeeklyPlanLLM {
  constructor(private readonly config: ModelConfig) {}

  async invoke(input: WeeklyPlanLlmInput): Promise<WeeklyPlan> {
    const startedAt = Date.now();
    logger.info(`Invoking weekly plan LLM for phase ${input.phase} (attempt ${input.previousSimulation?.attempt ?? 1})`);
    // logger.info(input, "weekly plan LLM input");

    const system = await buildSystemPrompt(input.phase);
    const user = buildUserPrompt(input);
    const model = buildResponsesModel(this.config).withStructuredOutput(toJsonSchema(WeeklyPlanGenerationSchema), {
      method: "jsonSchema",
    });
    const response = await model.invoke([new SystemMessage(system), new HumanMessage(user)]);

    if (response.success) {
      logger.info(response.weeklyPlan, "successfully generated WeeklyPlan. Position, before validation");
    } else {
      logger.info("failed to generate weekly plan %s", response.error);
    }

    if (!response.success) {
      throw new ModelContractError(`weekly plan model could not generate a plan: ${response.error}`);
    }
    console.log(`\n===== 生成的 weekly plan JSON =====\n${JSON.stringify(response.weeklyPlan, null, 2)}`);

    let validatedPlan: WeeklyPlan;
    try {
      validatedPlan = validateGeneratedWeeklyPlan(WeeklyPlanSchema.parse(response.weeklyPlan), input);
    } catch (error) {
      // throw new ModelContractError(`weekly plan model returned an invalid structured plan: ${error instanceof Error ? error.message : "invalid contract"}`);
    }
    // logger.info(
    //   `Generated weekly plan for phase ${input.phase} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (${validatedPlan.sessions.length} sessions)`,
    // );
    return WeeklyPlanSchema.parse(response.weeklyPlan);
  }
}

export function createWeeklyPlanLlm(config: ModelConfig): WeeklyPlanLLM {
  return new WeeklyPlanLLMImplementation(config);
}

async function buildSystemPrompt(phase: PhaseName): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const referencesDir = resolve(moduleDir, "../../skills/generate-weekly-plan/references");
  const reference = await readFile(resolve(referencesDir, `${phase}.md`), "utf8");
  const outputSchema = JSON.stringify(toJsonSchema(WeeklyPlanGenerationSchema), null, 2);
  return `${GENERATE_WEEKLY_PLAN_SYSTEM_PROMPT}\n\n# 输出 JSON Schema\n\n以下 schema 与 API response format 完全相同，必须据此生成完整结果：\n\n${outputSchema}\n\n# 阶段参考：${phase}\n\n${reference}`;
}

export function buildUserPrompt(input: WeeklyPlanLlmInput): string {
  const targetTrainingLoad = {
    target_distance_km_low: input.targetTrainingLoad.target_distance_km_low,
    target_distance_km_high: input.targetTrainingLoad.target_distance_km_high,
    target_training_load_low: input.targetTrainingLoad.training_load_low,
    target_training_load_high: input.targetTrainingLoad.training_load_high,
    load_ratio_low: input.targetTrainingLoad.load_ratio_low,
    load_ratio_high: input.targetTrainingLoad.load_ratio_high,
    remove_quality_stimulus: input.targetTrainingLoad.remove_quality_stimulus,
    rationale: input.targetTrainingLoad.details.rationale,
  };

  const targetWeek = {
    week_name: input.weeklyContext.week_name,
    week_start: input.weeklyContext.plan_start,
  };

  const userProfile = {
    age: input.weeklyContext.user_profile.age,
    gender: input.weeklyContext.user_profile.gender,
    weight_kg: input.weeklyContext.user_profile.weight_kg,
    lactate_threshold_pace_s_per_km: input.weeklyContext.user_profile.threshold_pace_s_per_km,
    lactate_threshold_hr: input.weeklyContext.user_profile.lactate_threshold_hr,
    rhr_baseline: input.weeklyContext.user_profile.rhr_baseline,
    hrv_baseline_low: input.weeklyContext.user_profile.hrv_baseline_low,
    hrv_baseline_high: input.weeklyContext.user_profile.hrv_baseline_high,
    heart_rate_zones: input.weeklyContext.user_profile.heart_rate_zones,
    pace_zones: input.weeklyContext.user_profile.pace_zones,
  };

  const strideLoad = input.weeklyContext.fitness_state.stride_training_load;
  const latestTrend = input.weeklyContext.fitness_state.trend.at(-1);
  const trainingStatus = {
    acute_training_load: strideLoad.acute_load,
    chronic_training_load: strideLoad.chronic_load,
    form: strideLoad.form,
    load_ratio: strideLoad.load_ratio,
    rhr: latestTrend?.rhr ?? null,
    hrv: latestTrend?.hrv ?? null,
    rhr_seven_day_average: input.weeklyContext.recovery.seven_day_average.rhr,
    hrv_seven_day_average: input.weeklyContext.recovery.seven_day_average.hrv,
    trend: input.weeklyContext.fitness_state.trend,
  };

  const phase = input.weeklyContext.training_position.phase;
  const recentTrainingWeeks = input.weeklyContext.recent_training_weeks;
  const previousSimulation = input.previousSimulation;
  const accepted =
    previousSimulation?.target_training_load_low === null ||
    previousSimulation?.target_training_load_low === undefined ||
    previousSimulation.target_training_load_high === null
      ? null
      : acceptedLoadBand(previousSimulation.target_training_load_low, previousSimulation.target_training_load_high);
  const retryFeedback =
    previousSimulation === null || previousSimulation === undefined
      ? undefined
      : {
          instruction: "上一轮计划未通过负荷校验。根据确定性模拟结果调整训练安排，使周总预估负荷进入验收区间，并重新检查目标跑量区间。",
          previous_attempt: previousSimulation.attempt,
          previous_total_dose: previousSimulation.total_dose,
          target_training_load_low: previousSimulation.target_training_load_low,
          target_training_load_high: previousSimulation.target_training_load_high,
          accepted_total_dose_low: accepted?.low ?? null,
          accepted_total_dose_high: accepted?.high ?? null,
        };

  return JSON.stringify({
    targetWeek,
    targetTrainingLoad,
    userProfile,
    trainingStatus,
    phase,
    recentTrainingWeeks,
    injury: input.weeklyContext.injury,
    ...(retryFeedback === undefined ? {} : { retryFeedback }),
  });
}

export function validateGeneratedWeeklyPlan(plan: WeeklyPlan, input: WeeklyPlanLlmInput): WeeklyPlan {
  // const hasRestDay = plan.sessions.some((session) => session.kind === "rest");
  // if (!hasRestDay) {
  //     throw new Error("weekly plan has no explicit rest day");
  // }
  const hasRunSession = plan.sessions.some((session) => session.kind === "run");
  if (!hasRunSession) {
    throw new Error("weekly plan has no run session");
  }

  const totalRunMeters = plan.sessions.filter((session) => session.kind === "run").reduce((total, session) => total + (session.total_distance_m ?? 0), 0);
  const targetKmHigh = number(input.targetTrainingLoad.target_distance_km_high);
  const anchorKm = number(input.weeklyContext.absorbed_load?.distance_anchor_km);
  const capKm = Math.max(targetKmHigh ?? 0, anchorKm ?? 0) * 1.1;
  logger.info(
    `weekly plan total run distance ${(totalRunMeters / 1000).toFixed(1)} km, target KM high ${targetKmHigh ?? 0} km, target cap ${capKm.toFixed(1)} km`,
  );

  if (capKm > 0 && totalRunMeters / 1000 > capKm) {
    throw new Error(`weekly plan total run distance ${(totalRunMeters / 1000).toFixed(1)} km exceeds the ${capKm.toFixed(1)} km cap`);
  }

  return plan;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
