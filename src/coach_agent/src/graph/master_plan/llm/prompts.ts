/** master plan kernel 只剩目标评估一个 LLM 提示（策略/评审/骨架四份提示随老拓扑删除，#803）。 */
import type { AssessmentFacts } from "../assessment.js";
import type { ContextSnapshot } from "../context.js";
import { MasterPlanGraphRequest } from "@stride/contract";

type PromptMessage = ["system" | "user", string];

export interface GoalAssessmentPromptInput {
  request: MasterPlanGraphRequest;
  snapshot: ContextSnapshot;
  facts: AssessmentFacts;
}

const GOAL_ASSESSMENT_SYSTEM = `你是马拉松训练可行性评估器。给定运动员的目标、已确认的训练条件与历史证据，判断目标在本赛季是否可达。

只输出 submit_goal_assessment 的结构化结果，不要解释过程。
- level 四档：reachable / attainable_with_discipline / multi_cycle_required / unsafe_or_incompatible
- 每条结论必须引用输入里真实存在的 fact_id；不要编造事实
- 目标明显偏离当前能力时给出多周期路径或冲突选项，不要为了迎合而压低风险`;

export function goalAssessmentPrompt(input: GoalAssessmentPromptInput): PromptMessage[] {
  return [
    ["system", GOAL_ASSESSMENT_SYSTEM],
    ["user", JSON.stringify({ request: input.request, facts: input.facts, athlete: input.snapshot })],
  ];
}
