/** master plan kernel 的 LLM 依赖装配（目标评估 + L2 判断层 + L4 内容层）。 */
import { buildModel } from "@stride/common";
import type { ModelConfig } from "../../../config/config.js";
import { GoalAssessmentSchema } from "../assessment.js";
import type { MasterPlanGraphDependencies } from "../nodes.js";
import { type ContentModel, createContentModel } from "../phasing/content/generate.js";
import { createPhasingModel, type PhasingModel } from "../phasing/generate.js";
import { goalAssessmentPrompt } from "./prompts.js";

export type MasterPlanLlmModels = Pick<MasterPlanGraphDependencies, "goalAssessmentModel" | "phasingModel" | "contentModel">;

export interface MasterPlanLlmOptions {
  /** 目标评估用的推理模型。 */
  masterPlanModel: ModelConfig;
  /** L2 阶段判断层（低温、结构化输出）。 */
  phasingModel: ModelConfig;
  /** L4 内容层（课包生成 + 排位）。 */
  contentModel: ModelConfig;
}

export function createMasterPlanLlmModels({ masterPlanModel, phasingModel, contentModel }: MasterPlanLlmOptions): MasterPlanLlmModels {
  const content: ContentModel = createContentModel(contentModel);
  const phasing: PhasingModel = createPhasingModel(phasingModel);

  return {
    goalAssessmentModel: {
      async invoke(input, retry) {
        return buildModel({
          ...masterPlanModel,
          structured: {
            schema: GoalAssessmentSchema,
            name: "submit_goal_assessment",
          },
        }).invoke(goalAssessmentPrompt({ ...input, retry }));
      },
    },
    phasingModel: phasing,
    contentModel: content,
  };
}
