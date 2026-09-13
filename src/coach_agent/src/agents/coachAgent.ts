import { END, InMemoryStore, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver, BaseStore } from "@langchain/langgraph-checkpoint";
import { getLogger } from "@stride/common";
import { type CoachAgentConfig, getAgentConfig } from "../config/config.js";
import type { DataProvider } from "../data/dataProvider.js";
import { getAgentNode } from "./agents.js";
import { withLangfuseInvokeTracing } from "./langfuse.js";
import { AgentsState } from "./state.js";

export { CoachContext, type CoachToolRuntime } from "./context.js";

const logger = getLogger("coachAgent");

export interface CoachAgentOptions {
  /** Runtime-owned LangGraph checkpointer adapter. */
  checkpointer?: BaseCheckpointSaver;
  /** Runtime-owned LangGraph long-term memory adapter. */
  store?: BaseStore;
}

export interface CoachAgent {
  invoke(input: unknown, invocationConfig: Record<string, unknown>): Promise<unknown>;
}

/**
 * Assemble the conversational coach graph: an intent-classifying orchestrator
 * routing to per-intent business nodes, each an inner ReAct agent whose final
 * AIMessage lands in the shared `messages` channel. No deepagents orchestrator
 * rewrite — the business node's answer IS the reply.
 */
export async function createCoachAgent(dataProvider: DataProvider, config: CoachAgentConfig, options: CoachAgentOptions = {}) {
  const orchestratorConfig = getAgentConfig(config, "orchestrator");
  logger.info(`creating orchestrator with model ${orchestratorConfig.name} (${orchestratorConfig.model})`);

  const graph = new StateGraph(AgentsState)
    .addNode("orchestrator", getAgentNode("orchestrator", config, dataProvider), { ends: ["qa", "other"] })
    .addNode("qa", getAgentNode("qa", config, dataProvider))
    .addNode("other", getAgentNode("other", config, dataProvider))
    .addEdge(START, "orchestrator")
    .addEdge("qa", END)
    .addEdge("other", END)
    .compile({
      checkpointer: options.checkpointer ?? new MemorySaver(),
      store: options.store ?? new InMemoryStore(),
    });

  return withLangfuseInvokeTracing(graph as never) as typeof graph;
}
