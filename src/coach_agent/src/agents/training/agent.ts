import type { GraphNode } from "@langchain/langgraph";
import { buildModel, getLogger } from "@stride/common";
import { type CoachAgentConfig, getAgentConfig } from "../../config/config.js";
import type { DataProvider } from "../../data/dataProvider.js";
import type { AgentsState } from "../state.js";
import { makeTrainingNode } from "./node.js";

const logger = getLogger("coachAgent:training");

/**
 * Build the training node（#1024 R2/R7）：master_plan 意图的一次快 LLM 槽位
 * 补全 → `master-plan-form` 预填表单卡。共用 coach 配置的 `master_plan` 角色
 * （deepseek-flash 秒级）；计划生成已出聊天管线——运动员确认表单后由小程序
 * 组装 kernel request 直投 plan-jobs，异步 worker 跑四层引擎（与 Admin 代
 * 生成同一队列）。旧 deepagent 生成器（#427 turn 内同步 10 分钟）随本改动
 * 退役。dataProvider 形参保留以维持 orchestrator 组装面不变。
 */
export function createTrainingNode(dataProvider: DataProvider, config: CoachAgentConfig): GraphNode<typeof AgentsState> {
  void dataProvider;
  const masterPlanModel = getAgentConfig(config, "master_plan");
  const llm = buildModel(masterPlanModel);
  logger.info(`creating training node with slot-filling model (${masterPlanModel.model})`);
  return makeTrainingNode({ llm });
}
