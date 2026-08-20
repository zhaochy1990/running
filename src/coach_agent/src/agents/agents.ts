import type { GraphNode } from "@langchain/langgraph";
import { getAgentConfig, type CoachAgentConfig } from "../config/config.js";
import { AgentsState } from "./state.js";
import { getOrchestratorNode } from "./orchestrator.js";

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
