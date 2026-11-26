import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";
import { getLogger } from "@stride/common";
import type { RaceStrategy } from "@stride/contract";
import { type RaceTargetBindingGateway, raceStrategyMatchesCourse, resolveRaceStrategyTarget } from "../../tools/raceStrategyContext.js";
import { normalizeMessageContent } from "../messages.js";
import type { AgentsState } from "../state.js";
import { RACE_STRATEGY_REQUEST, raceStrategyViewReply, readRaceStrategyHandoff } from "./handoff.js";
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
export function makeRaceStrategyNode(agent: InnerRaceAgent, raceTargets?: RaceTargetBindingGateway): GraphNode<typeof AgentsState> {
  return async (state, config) => {
    const result = await agent.invoke({ messages: state.messages }, config);
    const messages = result.messages.slice(state.messages.length);
    const handoff = readRaceStrategyHandoff(messages);
    if (handoff) return { messages: [raceStrategyViewReply(handoff, state.messages)], raceStrategy: null };
    const strategy = extractRaceStrategyResult(result) ?? leakedStrategyFromText(messages);
    if (strategy !== undefined) {
      const target = await resolveRaceStrategyTarget(config.context, raceTargets);
      if (raceTargets && target === null) {
        return { messages: [new AIMessage("请告诉我具体的比赛名称和参赛组别，我会在这里继续生成策略。")], raceStrategy: null };
      }
      if (target && (strategy.item_type !== target.item_type || !raceStrategyMatchesCourse(messages, target))) {
        return {
          messages: [new AIMessage(`这轮没有核对上当前赛事和组别的赛道资料。回复「${RACE_STRATEGY_REQUEST}」，我会按当前赛事重新查询。`)],
          raceStrategy: null,
        };
      }
      return { messages: [raceStrategyMessage(strategy, target?.race_event_id)], raceStrategy: strategy };
    }
    return {
      // 数组 content 归一化为字符串再入会话历史（devops#833）。
      messages: messages.map(normalizeMessageContent),
      raceStrategy: null,
    };
  };
}

/** 扫描本轮新增的 AI 文本，命中防御性信封解析则告警并捞回（见 render.ts）。 */
function leakedStrategyFromText(delta: BaseMessage[]): RaceStrategy | undefined {
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
