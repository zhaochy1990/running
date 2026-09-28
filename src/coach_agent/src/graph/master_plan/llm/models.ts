import { buildModel } from "@stride/common";
import { MasterPlanSchema, ReviewReportSchema, StrategyCandidateSchema, StrategyJudgmentSchema } from "@stride/contract";
import type { ModelConfig } from "../../../config/config.js";
import {
  authoritativeGoalLevel,
  canonicalizeAssessmentSummary,
  GoalAssessmentSchema,
  validateAssessmentReferences,
  validateGoalAssessmentTargets,
} from "../assessment.js";
import { type MasterPlanGraphDependencies, validateSkeletonAgainstStrategy } from "../nodes.js";
import { runMasterPlanRuleFilter } from "../rules.js";
import { goalAssessmentPrompt, judgmentPrompt, loadMasterPlanPromptAssets, reviewPrompt, skeletonPrompt, strategyPrompt } from "./prompts.js";

export type MasterPlanLlmModels = Pick<
  MasterPlanGraphDependencies,
  "goalAssessmentModel" | "strategyModel" | "judgmentModel" | "skeletonModel" | "reviewModel"
>;

export interface MasterPlanLlmOptions {
  masterPlanModel: ModelConfig;
  reviewerModel: ModelConfig;
}

export async function createMasterPlanLlmModels({ masterPlanModel, reviewerModel }: MasterPlanLlmOptions): Promise<MasterPlanLlmModels> {
  const { doctrine, reviewRubrics } = await loadMasterPlanPromptAssets();

  return {
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
                canonical.level !== authoritativeGoalLevel(input.facts) ||
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
              validateSkeletonAgainstStrategy(plan, input.selectedStrategy);
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
