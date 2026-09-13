import type { BaseMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";
import { type CoachAgentConfig, getAgentConfig } from "../config/config.js";
import type { DataProvider } from "../data/dataProvider.js";
import { getOrchestratorNode } from "./orchestrator.js";
import { getOtherAgent } from "./other/agent.js";
import { getQaAgent } from "./qa/agent.js";
import type { AgentsState } from "./state.js";

/** Minimal surface of an inner `createAgent` agent that a node needs to run it. */
interface InnerAgent {
  invoke(input: unknown, config?: unknown): Promise<{ messages: BaseMessage[] }>;
}

/**
 * Wrap an inner `createAgent` agent as an outer-graph node.
 *
 * The inner agent reads the shared `messages` channel and returns the full
 * conversation (input + generated). Only the delta is written back so the
 * outer `MessagesValue` add-messages reducer does not duplicate the input.
 */
function makeAgentNode(agent: InnerAgent): GraphNode<typeof AgentsState> {
  return async (state, config) => {
    const result = await agent.invoke({ messages: state.messages }, config);
    return { messages: result.messages.slice(state.messages.length) };
  };
}

export function getAgentNode(agentName: string, config: CoachAgentConfig, dataProvider: DataProvider): GraphNode<typeof AgentsState> {
  if (agentName === "orchestrator") {
    const agentConfig = getAgentConfig(config, "orchestrator");
    return getOrchestratorNode(agentConfig, { training_question: "qa", other: "other" });
  }

  if (agentName === "qa") {
    const agentConfig = getAgentConfig(config, "qa");
    return makeAgentNode(getQaAgent(dataProvider, agentConfig) as unknown as InnerAgent);
  }

  if (agentName === "other") {
    // `other` 复用 qa 的快速 chat 模型（思考关闭、低 effort），不新增独立 role。
    const agentConfig = getAgentConfig(config, "qa");
    return makeAgentNode(getOtherAgent(agentConfig) as unknown as InnerAgent);
  }

  throw new Error(`Unknown agent name: ${agentName}`);
}
