import type { BaseMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";
import { type CoachAgentConfig, getAgentConfig } from "../config/config.js";
import type { DataProvider } from "../data/dataProvider.js";
import { getOrchestratorNode } from "./orchestrator.js";
import { getOtherAgent } from "./other/agent.js";
import { getQaAgent } from "./qa/agent.js";
import type { AgentsState } from "./state.js";
import { createTrainingGraph } from "./training/graph.js";

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
    // 训练计划相关意图（weekly_plan / master_plan）统一路由到 training 子图；
    // 训练问答与其它意图仍交给 qa。分类结果写入 state.intent 供观测。
    return getOrchestratorNode(agentConfig, { training_question: "qa", weekly_plan: "training", master_plan: "training", other: "qa" });
  }

  if (agentName === "training") {
    return makeAgentNode(createTrainingGraph() as unknown as InnerAgent);
  }

  if (agentName === "qa") {
    const agentConfig = getAgentConfig(config, "qa");
    const qaAgent = getQaAgent(dataProvider, agentConfig) as unknown as InnerAgent;
    return makeAgentNode(qaAgent);
  }

  if (agentName === "other") {
    const agentConfig = getAgentConfig(config, "qa");
    const otherAgent = getOtherAgent(agentConfig) as unknown as InnerAgent;
    return makeAgentNode(otherAgent);
  }

  throw new Error(`Unknown agent name: ${agentName}`);
}
