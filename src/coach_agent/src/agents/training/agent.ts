import type { GraphNode } from "@langchain/langgraph";
import { getLogger } from "@stride/common";
import { type CoachAgentConfig, getAgentConfig } from "../../config/config.js";
import type { DataProvider } from "../../data/dataProvider.js";
import { DataProviderMasterPlanContextProvider } from "../../data/masterPlanContextProvider.js";
import { createMasterPlanGraph } from "../../graph/master_plan/index.js";
import { createMasterPlanLlmModels } from "../../graph/master_plan/llm/index.js";
import type { AgentsState } from "../state.js";
import { makeTrainingNode, type TrainingKernel } from "./node.js";

const logger = getLogger("coachAgent:training");

/**
 * Build the training node with the full master kernel in-process (#427).
 *
 * The API process consumes the `master_plan` + `reviewer` roles from the same
 * coach config the worker uses, so the in-turn kernel and the async-job kernel
 * run identical models — the difference is only who drives the graph.
 */
export async function createTrainingNode(dataProvider: DataProvider, config: CoachAgentConfig): Promise<GraphNode<typeof AgentsState>> {
  const masterPlanModel = getAgentConfig(config, "master_plan");
  const reviewerModel = getAgentConfig(config, "reviewer");
  const llmModels = await createMasterPlanLlmModels({ masterPlanModel, reviewerModel });
  const kernel = createMasterPlanGraph({
    contextProvider: new DataProviderMasterPlanContextProvider(dataProvider),
    ...llmModels,
  });
  logger.info(`creating training node with master kernel (master_plan=${masterPlanModel.model}, reviewer=${reviewerModel.model})`);
  return makeTrainingNode({ kernel: kernel as unknown as TrainingKernel, dataProvider });
}
