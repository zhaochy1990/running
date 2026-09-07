import type { GraphNode } from "@langchain/langgraph";
import { type CoachAgentConfig, getAgentConfig } from "../config/config.js";
import { getOrchestratorNode } from "./orchestrator.js";
import type { AgentsState } from "./state.js";

export function getAgentNode(agentName: string, config: CoachAgentConfig): GraphNode<typeof AgentsState> {
  const agentConfig = getAgentConfig(config, agentName);

  if (agentName === "orchestrator") {
    // Coach graph routing: training questions go to the qa node; other
    // intents fall through to END (their branches land later).
    return getOrchestratorNode(agentConfig, { training_question: "qa" });
  }

  if (agentName === "qa") {
  }

  throw new Error(`Unknown agent name: ${agentName}`);
}
