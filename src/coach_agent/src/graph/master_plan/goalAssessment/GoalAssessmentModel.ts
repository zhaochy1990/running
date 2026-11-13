import { buildModel, type ModelConfig } from "@stride/common";
import { type AssessmentFacts, GoalAssessmentSchema, type MasterPlanGraphRequest } from "@stride/contract";
import type { ContextSnapshot } from "../context.js";
import { goalAssessmentPrompt } from "../llm/prompts.js";

export interface GoalAssessmentModel {
  invoke(input: { request: MasterPlanGraphRequest; snapshot: ContextSnapshot; facts: AssessmentFacts }, retry?: { violations: string[] }): Promise<unknown>;
}

export class GoalAssessmentModelImpl implements GoalAssessmentModel {
  constructor(private readonly modelConfig: ModelConfig) {}

  public async invoke(
    input: { request: MasterPlanGraphRequest; snapshot: ContextSnapshot; facts: AssessmentFacts },
    retry?: { violations: string[] },
  ): Promise<unknown> {
    const llm = buildModel({
      ...this.modelConfig,
      structured: {
        schema: GoalAssessmentSchema,
        name: "submit_goal_assessment",
      },
    });

    return llm.invoke(goalAssessmentPrompt({ ...input, retry }));
  }
}
