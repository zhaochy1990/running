import type { BaseMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";
import { buildChatModel } from "@stride/common";
import { easyMidOfPaceZones } from "@stride/contract";
import { type CoachAgentConfig, getAgentConfig } from "../config/config.js";
import type { DataProvider } from "../data/dataProvider.js";
import type { ActivityFeelWriter } from "../tools/feel.js";
import { getCustomWorkoutAgent } from "./custom_workout/agent.js";
import { type CalibrationResolver, type ListCustomSessionsResolver, makeCustomWorkoutNode } from "./custom_workout/node.js";
import { normalizeMessageContent } from "./messages.js";
import { getOrchestratorNode } from "./orchestrator.js";
import { getOtherAgent } from "./other/agent.js";
import { getQaAgent } from "./qa/agent.js";
import { getRaceStrategyAgent } from "./race_strategy/agent.js";
import { makeRaceStrategyNode } from "./race_strategy/node.js";
import type { AgentsState } from "./state.js";
import { makeWorkoutManageNode } from "./workout_manage/node.js";

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
 * Delta content is normalized to plain strings first: responses-API models
 * emit content-parts arrays that poison chat-completions consumers downstream
 * (devops#833).
 */
function makeAgentNode(agent: InnerAgent): GraphNode<typeof AgentsState> {
  return async (state, config) => {
    const result = await agent.invoke({ messages: state.messages }, config);
    return { messages: result.messages.slice(state.messages.length).map(normalizeMessageContent) };
  };
}

export function getAgentNode(
  agentName: string,
  config: CoachAgentConfig,
  dataProvider: DataProvider,
  feelWriter?: ActivityFeelWriter,
): GraphNode<typeof AgentsState> {
  if (agentName === "orchestrator") {
    const agentConfig = getAgentConfig(config, "orchestrator");
    // master_plan 进 training 节点在聊天 turn 内同步跑 master kernel（#427）。
    // weekly_plan 暂留 qa（只读查看/解释周计划）——周计划的 turn 内生成另立票。
    const routes = {
      training_question: "qa",
      weekly_plan: "qa",
      master_plan: "training",
      race_strategy: "race_strategy",
      custom_workout: "custom_workout",
      workout_manage: "workout_manage",
      other: "qa",
    };
    return getOrchestratorNode(agentConfig, routes);
  }

  if (agentName === "qa") {
    const agentConfig = getAgentConfig(config, "qa");
    const qaAgent = getQaAgent(dataProvider, agentConfig, feelWriter) as unknown as InnerAgent;
    return makeAgentNode(qaAgent);
  }

  if (agentName === "race_strategy") {
    const agentConfig = getAgentConfig(config, "race_strategy");
    const raceAgent = getRaceStrategyAgent(dataProvider, agentConfig);
    return makeRaceStrategyNode(raceAgent);
  }

  if (agentName === "custom_workout") {
    const agentConfig = getAgentConfig(config, "custom_workout");
    const workoutAgent = getCustomWorkoutAgent(dataProvider, agentConfig);
    // dose 确定性计算的校准读取与工具同源（dataProvider，读不到→卡片 dose=null）；
    // easyPaceMidSPerKm 供契约⑨估距（devops#838）。
    const resolveCalibration: CalibrationResolver = async (userId, asof) => {
      const calibration = await dataProvider.getLatestRunningCalibration(userId, asof);
      return calibration === null
        ? null
        : {
            thresholdSpeedMps: calibration.thresholdSpeedMps,
            thresholdHr: calibration.thresholdHr,
            rhrBaseline: calibration.rhrBaseline,
            easyPaceMidSPerKm: easyMidOfPaceZones(calibration.paceZones),
          };
    };
    // reissue 注入（devops#697）：asof±14d 已存 custom 课（date/name/summary/save_token）。
    const listCustomSessions: ListCustomSessionsResolver = async (userId, dateFrom, dateTo) => {
      const rows = await dataProvider.getPlanSessions(userId, dateFrom, dateTo);
      return rows.filter((row) => row.source === "custom").map((row) => ({ date: row.date, name: row.name, summary: row.summary, save_token: row.save_token }));
    };
    return makeCustomWorkoutNode({ agent: workoutAgent, resolveCalibration, listCustomSessions });
  }

  if (agentName === "workout_manage") {
    const agentConfig = getAgentConfig(config, "workout_manage");
    // 角色 yaml 固定 api_kind=chat-completions（DeepSeek），JSON mode 走 ChatOpenAI。
    return makeWorkoutManageNode({
      model: buildChatModel(agentConfig),
      listSessions: (userId, dateFrom, dateTo) => dataProvider.getPlanSessions(userId, dateFrom, dateTo),
    });
  }

  if (agentName === "other") {
    const agentConfig = getAgentConfig(config, "qa");
    const otherAgent = getOtherAgent(agentConfig) as unknown as InnerAgent;
    return makeAgentNode(otherAgent);
  }

  throw new Error(`Unknown agent name: ${agentName}`);
}
