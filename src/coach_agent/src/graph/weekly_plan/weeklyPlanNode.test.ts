import assert from "node:assert/strict";
import test from "node:test";
import type { TargetTrainingLoad } from "@stride/contract";
import { createWeeklyPlanSimulationContext } from "./testFixtures.js";
import { buildUserPrompt, type WeeklyPlanLlmInput } from "./weeklyPlanNode.js";

function input(previousSimulation: Exclude<WeeklyPlanLlmInput["previousSimulation"], undefined>): WeeklyPlanLlmInput {
  return {
    phase: "recovery",
    weeklyContext: createWeeklyPlanSimulationContext(),
    targetTrainingLoad: {
      available: true,
      missing_reason: null,
      load_decision: "recover",
      training_load_low: 208,
      training_load_high: 233.9,
      target_distance_km_low: 45,
      target_distance_km_high: 52,
      load_ratio_low: 0.9,
      load_ratio_high: 1.1,
      remove_quality_stimulus: true,
      details: {
        last_complete_week: null,
        anchor: { training_load_avg4w: 260, distance_km_avg4w: 60 },
        trend: {
          recovery: null,
          seven_day_average: { rhr: 50, hrv: 45 },
          current_load_ratio: 1.3,
          form: -10,
          is_recovery_week: true,
          recovery_week_overridden: false,
          activity_restricted: false,
          recent_high_cost_training: true,
        },
        rationale: ["recovery week"],
      },
    } satisfies TargetTrainingLoad,
    previousSimulation,
  };
}

test("buildUserPrompt omits retry feedback on the first attempt", () => {
  const prompt = JSON.parse(buildUserPrompt(input(null))) as Record<string, unknown>;

  assert.equal("retryFeedback" in prompt, false);
});

test("buildUserPrompt includes deterministic load feedback on retries", () => {
  const prompt = JSON.parse(
    buildUserPrompt(
      input({
        attempt: 2,
        total_dose: 258.8,
        target_training_load_low: 208,
        target_training_load_high: 233.9,
      }),
    ),
  ) as { retryFeedback: Record<string, unknown> };

  assert.deepEqual(prompt.retryFeedback, {
    instruction: "上一轮计划未通过负荷校验。根据确定性模拟结果调整训练安排，使周总预估负荷进入验收区间，并重新检查目标跑量区间。",
    previous_attempt: 2,
    previous_total_dose: 258.8,
    target_training_load_low: 208,
    target_training_load_high: 233.9,
    accepted_total_dose_low: 187.2,
    accepted_total_dose_high: 257.29,
  });
});
