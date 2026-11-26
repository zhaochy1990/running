import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";
import { getLogger } from "@stride/common";
import type { RaceStrategy } from "@stride/contract";
import type { RaceTargetBindingGateway } from "../../tools/raceStrategyContext.js";
import { normalizeMessageContent } from "../messages.js";
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
export function makeRaceStrategyNode(agent: InnerRaceAgent, raceTargets?: RaceTargetBindingGateway): GraphNode<typeof AgentsState> {
  return async (state, config) => {
    const result = await agent.invoke({ messages: state.messages }, config);
    const strategy = extractRaceStrategyResult(result) ?? leakedStrategyFromText(result, state);
    if (strategy !== undefined) {
      const raceEventId = await resolveRaceEventId(config, raceTargets);
      if (raceTargets && raceEventId === undefined) {
        return { messages: [new AIMessage("请告诉我具体的比赛名称和参赛组别，我会在这里继续生成策略。")], raceStrategy: null };
      }
      return { messages: [raceStrategyMessage(strategy, raceEventId)], raceStrategy: strategy };
    }
    return {
      // 数组 content 归一化为字符串再入会话历史（devops#833）。
      messages: result.messages.slice(state.messages.length).map(normalizeMessageContent),
      raceStrategy: null,
    };
  };
}

/**
 * 赛事页入口的 target 已在调用上下文中。聊天入口可能在本轮生成策略前
 * 才绑定赛事，调用上下文不会随之改变，需回读同一线程的可信绑定。
 */
async function resolveRaceEventId(config: unknown, raceTargets?: RaceTargetBindingGateway): Promise<number | undefined> {
  const context = (config as { context?: { threadId?: unknown; target?: { kind?: unknown; race_event_id?: unknown } } } | undefined)?.context;
  const target = context?.target;
  if (target?.kind === "race" && typeof target.race_event_id === "number" && Number.isInteger(target.race_event_id) && target.race_event_id > 0) {
    return target.race_event_id;
  }
  if (typeof context?.threadId !== "string") return undefined;
  return (await raceTargets?.get(context.threadId))?.race_event_id;
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
