import { buildModel } from "@stride/common";
import { MasterPlanSchema, ReviewReportSchema, StrategyCandidateSchema, StrategyJudgmentSchema } from "@stride/contract";
import type { ModelConfig } from "../../../config/config.js";
import {
  AthleteAssessmentSchema,
  authoritativeContinuity,
  authoritativeGoalLevel,
  authoritativeReadiness,
  canonicalizeAssessmentSummary,
  GoalAssessmentSchema,
  validateAssessmentReferences,
  validateAthleteAssessmentRanges,
  validateGoalAssessmentTargets,
} from "../assessment.js";
import { type MasterPlanGraphDependencies, validateSkeletonAgainstStrategy } from "../nodes.js";
import { runMasterPlanRuleFilter } from "../rules.js";
import {
  athleteAssessmentPrompt,
  goalAssessmentPrompt,
  judgmentPrompt,
  loadMasterPlanPromptAssets,
  reviewPrompt,
  skeletonPrompt,
  strategyPrompt,
} from "./prompts.js";

export type MasterPlanLlmModels = Pick<
  MasterPlanGraphDependencies,
  "assessmentModel" | "goalAssessmentModel" | "strategyModel" | "judgmentModel" | "skeletonModel" | "reviewModel"
>;

export interface MasterPlanLlmOptions {
  masterPlanModel: ModelConfig;
  reviewerModel: ModelConfig;
}

export async function createMasterPlanLlmModels({ masterPlanModel, reviewerModel }: MasterPlanLlmOptions): Promise<MasterPlanLlmModels> {
  const { doctrine, reviewRubrics } = await loadMasterPlanPromptAssets();

  return {
    assessmentModel: {
      async invoke(input) {
        return buildModel({
          ...masterPlanModel,
          structured: {
            schema: AthleteAssessmentSchema,
            name: "submit_athlete_assessment",
            validate: (assessment) => {
              const canonical = canonicalizeAssessmentSummary(assessment);
              validateAssessmentReferences(canonical, input.facts);
              validateAthleteAssessmentRanges(canonical, input.facts, input.request);
              if (canonical.readiness !== authoritativeReadiness(input.facts)) {
                throw new Error("readiness conflict");
              }
              if (canonical.continuity !== authoritativeContinuity(input.facts)) {
                throw new Error("continuity conflict");
              }
              return canonical;
            },
          },
        }).invoke(athleteAssessmentPrompt(input));
      },
    },
    goalAssessmentModel: {
      async invoke(input) {
        return buildModel({
          ...masterPlanModel,
          structured: {
            schema: GoalAssessmentSchema,
            name: "submit_goal_assessment",
            validate: (assessment) => {
              const canonical = canonicalizeAssessmentSummary(assessment);
              validateAssessmentReferences(canonical, input.facts);
              validateGoalAssessmentTargets(canonical, input.request, input.facts);
              if (
                canonical.level !== authoritativeGoalLevel(input.facts, input.athleteAssessment) ||
                (canonical.level !== "multi_cycle_required" && canonical.multi_cycle_path.length > 0)
              ) {
                throw new Error("goal classification conflict");
              }
              return canonical;
            },
          },
        }).invoke(goalAssessmentPrompt(input));
      },
    },
    strategyModel: {
      async invoke(input) {
        return buildModel({
          ...masterPlanModel,
          structured: { schema: StrategyCandidateSchema, name: `submit_${input.archetype}_strategy` },
        }).invoke(strategyPrompt(input, doctrine));
      },
    },
    judgmentModel: {
      async invoke(input) {
        return buildModel({
          ...reviewerModel,
          structured: { schema: StrategyJudgmentSchema, name: `submit_${input.judge}_judgment` },
        }).invoke(judgmentPrompt(input, doctrine));
      },
    },
    skeletonModel: {
      async invoke(input) {
        return buildModel({
          ...masterPlanModel,
          structured: {
            schema: MasterPlanSchema,
            name: "submit_master_plan_skeleton",
            validate: (plan) => {
              const report = runMasterPlanRuleFilter(plan, input.request, input.snapshot);
              if (report.has_errors) {
                const errors = report.violations
                  .filter((item) => item.severity === "error")
                  .map((item) => `${item.rule_id}:${item.message}`)
                  .join("; ");
                throw new Error(`deterministic rule errors: ${errors}`);
              }
              validateSkeletonAgainstStrategy(plan, input.selectedStrategy, input.athleteAssessment);
              return plan;
            },
          },
        }).invoke(skeletonPrompt(input, doctrine));
      },
    },
    reviewModel: {
      async invoke(input) {
        const rubric = reviewRubrics[input.reviewerType];
        return buildModel({
          ...reviewerModel,
          structured: { schema: ReviewReportSchema, name: `submit_${input.reviewerType}_review` },
        }).invoke(reviewPrompt(input, rubric));
      },
    },
  };
}
