import type { BaseMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";
import { type CoachAgentConfig, getAgentConfig } from "../config/config.js";
import type { DataProvider } from "../data/dataProvider.js";
import { getOrchestratorNode } from "./orchestrator.js";
import { getOtherAgent } from "./other/agent.js";
import { getQaAgent } from "./qa/agent.js";
import { getRaceStrategyAgent } from "./race_strategy/agent.js";
import { makeRaceStrategyNode } from "./race_strategy/node.js";
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
    // master_plan 进 training 节点在聊天 turn 内同步跑 master kernel（#427）。
    // weekly_plan 暂留 qa（只读查看/解释周计划）——周计划的 turn 内生成另立票。
    const routes = { training_question: "qa", weekly_plan: "qa", master_plan: "training", race_strategy: "race_strategy", other: "qa" };
    return getOrchestratorNode(agentConfig, routes);
  }

  if (agentName === "qa") {
    const agentConfig = getAgentConfig(config, "qa");
    const qaAgent = getQaAgent(dataProvider, agentConfig) as unknown as InnerAgent;
    return makeAgentNode(qaAgent);
  }

  if (agentName === "race_strategy") {
    const agentConfig = getAgentConfig(config, "race_strategy");
    const raceAgent = getRaceStrategyAgent(dataProvider, agentConfig);
    return makeRaceStrategyNode(raceAgent);
  }

  if (agentName === "other") {
    const agentConfig = getAgentConfig(config, "qa");
    const otherAgent = getOtherAgent(agentConfig) as unknown as InnerAgent;
    return makeAgentNode(otherAgent);
  }

  throw new Error(`Unknown agent name: ${agentName}`);
}
