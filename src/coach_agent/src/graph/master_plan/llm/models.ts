import { buildModel } from "@stride/common";
import { MasterPlanSchema, ReviewReportSchema, StrategyCandidateSchema, StrategyJudgmentSchema } from "@stride/contract";
import type { ModelConfig } from "../../../config/config.js";
import {
  canonicalizeAssessmentSummary,
  GoalAssessmentSchema,
  validateAssessmentReferences,
  validateGoalAssessmentTargets,
  withAuthoritativeLevel,
  withBackfilledClaimCitations,
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
              const canonical = withAuthoritativeLevel(
                withBackfilledClaimCitations(canonicalizeAssessmentSummary(assessment), input.facts),
                input.facts,
              );
              validateAssessmentReferences(canonical, input.facts);
              validateGoalAssessmentTargets(canonical, input.request, input.facts);
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
              // 未完成的 phase 带 summary 是确定性的契约违规（规则只看
              // is_completed），服务器端直接置 null，不为它烧掉整次生成。
              const canonical = { ...plan, phases: plan.phases.map((phase) => (phase.is_completed ? phase : { ...phase, summary: null })) };
              const report = runMasterPlanRuleFilter(canonical, input.request, input.snapshot);
              if (report.has_errors) {
                const errors = report.violations
                  .filter((item) => item.severity === "error")
                  .map((item) => {
                    const issues = (item.evidence as { issues?: Array<{ path: string; message: string }> } | undefined)?.issues;
                    return `${item.rule_id}:${item.message}${issues?.length ? ` (${issues.slice(0, 4).map((issue) => `${issue.path}:${issue.message}`).join(" | ")})` : ""}`;
                  })
                  .join("; ");
                throw new Error(`deterministic rule errors: ${errors}`);
              }
              validateSkeletonAgainstStrategy(canonical, input.selectedStrategy);
              return canonical;
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
