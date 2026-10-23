import type { BaseMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";
import { getLogger } from "@stride/common";
import type { RaceStrategy } from "@stride/contract";
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
 * - No structured output (insufficient-basis declaration, follow-up question):
 *   behaves like every other business node — the message delta is written back.
 *   The delta is first checked against the defensive envelope parser: a model
 *   that skipped the ToolStrategy call and emitted the envelope as plain text
 *   is recovered here instead of leaking raw JSON to the athlete.
 */
export function makeRaceStrategyNode(agent: InnerRaceAgent): GraphNode<typeof AgentsState> {
  return async (state, config) => {
    const result = await agent.invoke({ messages: state.messages }, config);
    const strategy = extractRaceStrategyResult(result) ?? leakedStrategyFromText(result, state);
    if (strategy !== undefined) {
      return { messages: [raceStrategyMessage(strategy, raceEventIdFromContext(config))], raceStrategy: strategy };
    }
    return {
      messages: result.messages.slice(state.messages.length),
      raceStrategy: null,
    };
  };
}

/**
 * 会话 target 的 race_event_id（#715）：随卡片 data 持久化，分享创建端据此
 * 提取 strategy_refs.race_id。context 经 invoke config 顶层透传（chat.ts
 * buildConfig），形状不对一律返回 undefined——只为溯源，绝不能挡生成。
 */
function raceEventIdFromContext(config: unknown): number | undefined {
  const target = (config as { context?: { target?: { kind?: unknown; race_event_id?: unknown } } } | undefined)?.context?.target;
  return target?.kind === "race" && typeof target.race_event_id === "number" && Number.isInteger(target.race_event_id) && target.race_event_id > 0
    ? target.race_event_id
    : undefined;
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
