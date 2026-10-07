import type { GraphNode } from "@langchain/langgraph";
import { getLogger } from "@stride/common";
import { type CoachAgentConfig, getAgentConfig } from "../../config/config.js";
import type { DataProvider } from "../../data/dataProvider.js";
import { getMasterPlanGeneratorSubagent } from "../master_plan/agent.js";
import type { AgentsState } from "../state.js";
import { makeTrainingNode } from "./node.js";

const logger = getLogger("coachAgent:training");

/**
 * Build the training node with the deepagent-style generate-master-plan agent
 * in-process（chat 内同步生成，#427）。共用 coach 配置的 `master_plan` 角色，
 * 与 worker 的 kernel（Admin 代生成 job）互不影响。
 */
export function createTrainingNode(dataProvider: DataProvider, config: CoachAgentConfig): GraphNode<typeof AgentsState> {
  const masterPlanModel = getAgentConfig(config, "master_plan");
  const agent = getMasterPlanGeneratorSubagent(dataProvider, masterPlanModel);
  logger.info(`creating training node with generate-master-plan agent (${masterPlanModel.model})`);
  return makeTrainingNode({ agent: agent as unknown as ReturnType<typeof getMasterPlanGeneratorSubagent> });
}
