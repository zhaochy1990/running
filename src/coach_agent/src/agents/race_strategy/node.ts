import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";
import { getLogger } from "@stride/common";
import type { RaceStrategy } from "@stride/contract";
import { ASK_USER_FOR_GOAL_TOOL } from "../../tools/raceStrategyContext.js";
import type { AgentsState } from "../state.js";
import { extractRaceStrategyResult, parseRaceStrategyFromText, raceStrategyMessage } from "./render.js";

const logger = getLogger("race_strategy_node");

/** Minimal surface of the inner race-strategy agent the node needs. */
interface InnerRaceAgent {
  invoke(input: unknown, config?: unknown): Promise<{ messages: BaseMessage[] } & Record<string, unknown>>;
}

/**
 * Wrap the inner race-strategy agent as an outer-graph node. Two outcomes:
 *
 * - Structured strategy produced: the validated artifact is rendered to a
 *   markdown reply (no model rewrite, mirroring the plan passthrough rule) and
 *   written to the `raceStrategy` channel for the coach API to project. Only
 *   the rendered reply enters the outer message history — the inner agent's
 *   tool-call trail (including the structured-output fake tool call) stays
 *   inside this node.
 * - Goal question turn (the agent called ask_user_for_goal): the reply is NOT
 *   the model's own text — the tool's one-sentence question (built
 *   deterministically from the athlete's stored race goal) replaces whatever
 *   the model wrote around it. Weak models pad free-text questions with course
 *   digressions otherwise.
 * - Otherwise (insufficient-basis declaration): behaves like every other
 *   business node — the message delta is written back. The delta is first
 *   checked against the defensive envelope parser: a model that skipped the
 *   ToolStrategy call and emitted the envelope as plain text is recovered here
 *   instead of leaking raw JSON to the athlete.
 */
export function makeRaceStrategyNode(agent: InnerRaceAgent): GraphNode<typeof AgentsState> {
  return async (state, config) => {
    const result = await agent.invoke({ messages: state.messages }, config);
    const strategy = extractRaceStrategyResult(result) ?? leakedStrategyFromText(result, state);
    if (strategy !== undefined) {
      return { messages: [raceStrategyMessage(strategy)], raceStrategy: strategy };
    }
    const question = askGoalQuestionFromTrail(result, state);
    if (question !== undefined) {
      return { messages: [new AIMessage(question)], raceStrategy: null };
    }
    return {
      messages: result.messages.slice(state.messages.length),
      raceStrategy: null,
    };
  };
}

/** 本轮新增消息里找 ask_user_for_goal 的工具结果，命中则取它的一句话文案。 */
function askGoalQuestionFromTrail(result: { messages: BaseMessage[] }, state: { messages: BaseMessage[] }): string | undefined {
  const delta = result.messages.slice(state.messages.length);
  const callIds = new Set<string>();
  for (const message of delta) {
    if (message.getType() !== "ai") continue;
    const toolCalls = (message as { tool_calls?: Array<{ name?: unknown; id?: unknown }> }).tool_calls ?? [];
    for (const call of toolCalls) {
      if (call.name === ASK_USER_FOR_GOAL_TOOL && typeof call.id === "string") callIds.add(call.id);
    }
  }
  if (callIds.size === 0) return undefined;
  // 工具结果在本轮轨迹里必然晚于调用；取最后一条，防模型一轮内多次调用。
  for (let index = delta.length - 1; index >= 0; index -= 1) {
    const message = delta[index];
    if (message === undefined || message.getType() !== "tool") continue;
    if (!callIds.has(String((message as { tool_call_id?: unknown }).tool_call_id))) continue;
    const question = questionFromToolResult((message as { content?: unknown }).content);
    if (question !== undefined) return question;
  }
  logger.warn("ask_user_for_goal was called but no usable tool result is in the trail; passing the model text through");
  return undefined;
}

/** 工具结果是序列化的 { question }；序列化口径变化时按原文兜底，空串视为不可用。 */
function questionFromToolResult(content: unknown): string | undefined {
  if (typeof content !== "string") return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      const question = (parsed as { question?: unknown }).question;
      if (typeof question === "string" && question.trim().length > 0) return question;
    }
  } catch {
    // 不是 JSON 围栏包裹的形态，落到原文。
  }
  return content.trim().length > 0 ? content : undefined;
}

/** 扫描本轮新增的 AI 文本，命中防御性信封解析则告警并捞回（见 render.ts）。 */
function leakedStrategyFromText(result: { messages: BaseMessage[] }, state: { messages: BaseMessage[] }): RaceStrategy | undefined {
  const delta = result.messages.slice(state.messages.length);
  for (let index = delta.length - 1; index >= 0; index -= 1) {
    const message = delta[index];
    if (message === undefined || message.getType() !== "ai" || typeof message.content !== "string") continue;
    const strategy = parseRaceStrategyFromText(message.content);
    if (strategy === undefined) return undefined;
    // 信封本应只经 ToolStrategy 伪工具调用产出；走文本意味着模型没守格式
    // （弱模型上已观察到），值得在监控里可见。
    logger.warn({ preview: message.content.slice(0, 120) }, "race-strategy envelope leaked as plain text; recovered by defensive parse");
    return strategy;
  }
  return undefined;
}
