import { buildModel, getLogger, type ModelConfig } from "@stride/common";
import { type AssessmentFacts, type GoalAssessment, GoalAssessmentSchema, type MasterPlanGraphRequest } from "@stride/contract";
import type { ContextSnapshot } from "../context.js";
import { goalAssessmentPrompt } from "../llm/prompts.js";
import { withAuthoritativeLevel } from "./assessment.js";

const logger = getLogger("GoalAssessment");

export interface GoalAssessmentModel {
  invoke(
    input: { request: MasterPlanGraphRequest; snapshot: ContextSnapshot; facts: AssessmentFacts },
    retry?: { violations: string[] },
  ): Promise<GoalAssessment>;
}

export class GoalAssessmentModelImpl implements GoalAssessmentModel {
  constructor(private readonly modelConfig: ModelConfig) {}

  public async invoke(
    input: { request: MasterPlanGraphRequest; snapshot: ContextSnapshot; facts: AssessmentFacts },
    retry?: { violations: string[] },
  ): Promise<GoalAssessment> {
    const llm = buildModel({
      ...this.modelConfig,
      structured: {
        schema: GoalAssessmentSchema,
        name: "submit_goal_assessment",
        // validate: (assessment) => {
        //   const canonical = withAuthoritativeLevel(withBackfilledClaimCitations(canonicalizeAssessmentSummary(assessment), input.facts), input.facts);
        //   validateAssessmentReferences(canonical, input.facts);
        //   validateGoalAssessmentTargets(canonical, input.request, input.facts);
        //   return canonical;
        // },
      },
    });

    logger.info("Invoking goal assessment model, request id %s, retry: %s", input.request.request_id, retry);
    const assessment = await llm.invoke(goalAssessmentPrompt({ ...input, retry }));
    logger.info("Goal assessment model completed, request id %s", input.request.request_id);

    // const assessmentSummary = canonicalizeAssessmentSummary(assessment);
    // const result = withBackfilledClaimCitations(assessment, input.facts);
    const canonical = withAuthoritativeLevel(assessment, input.facts);
    // validateAssessmentReferences(canonical, input.facts);
    // validateGoalAssessmentTargets(canonical, input.request, input.facts);

    // try {
    //   validateAssessmentReferences(assessment, facts);
    // } catch (error) {
    //   if (!(error instanceof UnsupportedRunwayClaimError)) throw error;
    //   const remaining = assessment.material_conclusions.filter((item) => item.claim !== "goal_runway_limited");
    //   if (remaining.length > 0) {
    //     assessment = { ...assessment, material_conclusions: remaining };
    //     logger.warn(
    //       { event: "goal_runway_claim_corrected", attempt, fact_id: "race.a.weeks_to_race" },
    //       "Removed unsupported runway claim after validating all other evidence and targets",
    //     );
    //   } else {
    //     if (attempt === 2) throw error;
    //     retry = { violations: [error.message, "Return at least one supported conclusion with valid evidence; do not return an empty assessment."] };
    //     logger.warn(
    //       { event: "goal_runway_claim_retry", attempt, fact_id: "race.a.weeks_to_race" },
    //       "Only conclusion contradicts runway facts; retrying assessment once",
    //     );
    //   }
    // }

    return canonical;
  }
}
