import { getLogger } from "@stride/common";
import { createAgent } from "langchain";
import type { ModelConfig } from "../../config/config.js";
import type { DataProvider } from "../../data/dataProvider.js";
import { createActivitiesTools } from "../../tools/activities.js";
import { createPlanTools } from "../../tools/plan.js";
import { createRaceTools } from "../../tools/races.js";
import { createRunningCalibrationTools } from "../../tools/runningCalibration.js";
import { createTrainingLoadTools } from "../../tools/trainingLoad.js";
import { buildModel } from "../common.js";
import { CoachContext } from "../context.js";
import { createLoggingMiddleware } from "../middleware.js";
import { loadSkillMarkdown } from "../skillLoader.js";
import { createTurnScopeMiddleware } from "../turnScope.js";

const logger = getLogger("coachAgent:qa");

// TODO: 关于跑步知识需要外接知识库
const QA_SUBAGENT_PROMPT = `你是 STRIDE 跑步教练的训练问答专家，你可以回答用户关于训练的问题。包括下面几类：
1. 今天/最近跑得怎么样？（今天的跑步数据、最近的训练状态）
2. 训练状态、疲劳与负荷（训练负荷、疲劳状态、恢复情况）
3. 跑步知识（跑步技巧、训练方法、运动科学知识）
4. 查看当前赛季计划、或某一周训练计划的内容

当前时间以最新一条用户消息里的 timestamp 为准。

只要问题涉及疲劳、负荷、恢复、状态、能否加量，都必须先调用 get_daily_training_load 拿到近期负荷趋势，并结合 chronic/acute/loadRatio/form 分析后再作答；不要只凭单次跑步的感觉下结论。

能用工具查到的事实，先自己查清楚再回答；只有确实不在数据里的东西（比如官方成绩、你当时的主观感受、天气），才向运动员确认。

当需要分析后程掉速、配速拆解、或者训练分段详情等需要查看运动详情的问题，用 get_activity_details 取到分段再回答，不要询问用户训练数据。

计划工具是只读的：你可以查看和解释计划内容，但不得修改、生成计划，也不得建议对计划做具体改动（那属于计划功能）。

你不对运动员的训练计划进行修改或调整，也不提供个性化训练建议。你只回答运动员关于训练的问题，并且只依据工具数据说话。
    `;

/** qa 子代理使用的只读工具集（供测试复用）。 */
export function getQaTools(store: DataProvider) {
  return [
    ...createPlanTools(store),
    ...createActivitiesTools(store),
    ...createTrainingLoadTools(store),
    ...createRaceTools(store),
    ...createRunningCalibrationTools(store),
  ];
}

/** qa 业务节点：一个内层 ReAct agent，最终 AIMessage 写回外层 messages。 */
export function getQaAgent(store: DataProvider, config: ModelConfig) {
  logger.info(`creating qa agent with model ${config.name} (${config.model})`);

  // 无 deepagents FilesystemBackend 后，把 SKILL.md 正文直接内联进系统提示。
  const systemPrompt = [QA_SUBAGENT_PROMPT, loadSkillMarkdown("analyze-activity"), loadSkillMarkdown("analyze-race")].join("\n\n");

  return createAgent({
    model: buildModel(config),
    tools: getQaTools(store),
    systemPrompt,
    contextSchema: CoachContext,
    middleware: [createTurnScopeMiddleware(), createLoggingMiddleware("agent:qa")],
  });
}
