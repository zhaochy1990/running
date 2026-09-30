import type { BaseMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";
import type { AgentsState } from "../state.js";
import { extractRaceStrategyResult, raceStrategyMessage } from "./render.js";

/** Minimal surface of the inner race-strategy agent the node needs. */
interface InnerRaceAgent {
  invoke(input: unknown, config?: unknown): Promise<{ messages: BaseMessage[] } & Record<string, unknown>>;
}

/**
 * Wrap the inner race-strategy agent as an outer-graph node. Two outcomes:
 *
 * - Structured strategy produced: the validated artifact is rendered to a
 *   markdown reply (no model rewrite, mirroring the plan passthrough rule) and
 *   written to the `raceStrategy` channel for the coach API to persist. Only
 *   the rendered reply enters the outer message history — the inner agent's
 *   tool-call trail (including the structured-output fake tool call) stays
 *   inside this node.
 * - No structured output (insufficient-basis declaration, follow-up question):
 *   behaves like every other business node — the message delta is written back.
 */
export function makeRaceStrategyNode(agent: InnerRaceAgent): GraphNode<typeof AgentsState> {
  return async (state, config) => {
    const result = await agent.invoke({ messages: state.messages }, config);
    const strategy = extractRaceStrategyResult(result);
    if (strategy !== undefined) {
      return { messages: [raceStrategyMessage(strategy)], raceStrategy: strategy };
    }
    return {
      messages: result.messages.slice(state.messages.length),
      raceStrategy: null,
    };
  };
}
