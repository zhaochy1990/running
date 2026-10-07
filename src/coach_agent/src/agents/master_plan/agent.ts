import type { StructuredTool } from "@langchain/core/tools";
import { buildModel, buildResponsesModel, getLogger } from "@stride/common";
import { MasterPlanLenientDirectResponseSchema } from "@stride/contract";
import type { AgentMiddleware } from "langchain";
import { createAgent, ToolStrategy } from "langchain";
import type { ModelConfig } from "../../config/config.js";
import type { DataProvider } from "../../data/dataProvider.js";
import { DataProviderMasterPlanContextProvider } from "../../data/masterPlanContextProvider.js";
import { createActivitiesTools } from "../../tools/activities.js";
import { askUserQuestionTool } from "../../tools/askUserQuestions.js";
import { createMasterPlanContextTools } from "../../tools/masterPlanContext.js";
import { createPlanTools } from "../../tools/plan.js";
import { createRaceTools } from "../../tools/races.js";
import { createRunningCalibrationTools } from "../../tools/runningCalibration.js";
import { createTrainingLoadTools } from "../../tools/trainingLoad.js";
import { CoachContext } from "../context.js";
import { createLoggingMiddleware } from "../middleware.js";
import { MASTER_PLAN_PROMPT, MASTER_PLAN_READ_PROMPT } from "../prompts.js";
import { loadSkillMarkdown } from "../skillLoader.js";
import { createTurnScopeMiddleware } from "../turnScope.js";

const logger = getLogger("coachAgent:master_plan");

/** 只读赛季计划视图的子代理定义（保留 deepagents 时代的配置面；图未接线）。 */
export function getMasterPlanSubagent(store: DataProvider, config: ModelConfig) {
  const tools = [
    ...createActivitiesTools(store),
    ...createTrainingLoadTools(store),
    ...createPlanTools(store),
    ...createRaceTools(store),
    ...createRunningCalibrationTools(store),
    askUserQuestionTool,
  ];
  logger.info(`creating master_plan subagent with model ${config.name} (${config.model})`);
  return {
    name: "master_plan",
    description: "查看或讨论既有赛季/总体训练计划（阶段、里程碑、周期），不生成新的计划草案。",
    systemPrompt: MASTER_PLAN_READ_PROMPT,
    tools,
    model: buildResponsesModel(config),
    middleware: [createTurnScopeMiddleware(), createLoggingMiddleware("agent:master_plan")],
  };
}

export interface MasterPlanGeneratorParts {
  readonly tools: StructuredTool[];
  readonly systemPrompt: string;
  readonly middleware: AgentMiddleware[];
}

/**
 * 生成器的可测部件（deepagent 版，替代 chat 内 master kernel）：
 * - get_master_plan_context 一次拿全有界上下文（race_target / PB / 校准 / 历史 / 负荷）；
 * - get_master_plan 供参考当前激活计划（重新制定时说明替换关系）；
 * - 技能文档（丹尼尔斯体系）内联进系统提示——deepagents FilesystemBackend 已不存在；
 * - 信封走 shape-only 宽松 schema，且不挂确定性校验中间件：跨字段内容规则
 *   （比赛周激活量、周课次数等）先跳过（临时决策），规则回归另立票；
 * - 不挂 askUserQuestionTool：内层 agent 不带 checkpointer，interrupt() 直接抛错，
 *   客户端追问也是新消息而非 resume；追问一律普通文本（与 race_strategy 同约定）。
 */
export function getMasterPlanGeneratorParts(store: DataProvider): MasterPlanGeneratorParts {
  const tools: StructuredTool[] = [
    ...createPlanTools(store).filter((tool) => tool.name === "get_master_plan"),
    ...createMasterPlanContextTools(new DataProviderMasterPlanContextProvider(store)),
  ];
  const systemPrompt = [MASTER_PLAN_PROMPT, loadSkillMarkdown("generate-master-plan")].join("\n\n");
  return {
    tools,
    systemPrompt,
    middleware: [createTurnScopeMiddleware(), createLoggingMiddleware("agent:generate_master_plan")],
  };
}

/** Dedicated generator: an inner createAgent whose ToolStrategy envelope carries the MasterPlan. */
export function getMasterPlanGeneratorSubagent(store: DataProvider, config: ModelConfig) {
  logger.info(`creating generate_master_plan agent with model ${config.name} (${config.model})`);
  const { tools, systemPrompt, middleware } = getMasterPlanGeneratorParts(store);
  return createAgent({
    model: buildModel(config),
    tools,
    systemPrompt,
    contextSchema: CoachContext,
    responseFormat: ToolStrategy.fromSchema(MasterPlanLenientDirectResponseSchema),
    middleware,
  });
}
