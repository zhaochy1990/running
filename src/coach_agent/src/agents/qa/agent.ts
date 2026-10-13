import { buildModel, getLogger } from "@stride/common";
import { createAgent } from "langchain";
import type { ModelConfig } from "../../config/config.js";
import type { DataProvider } from "../../data/dataProvider.js";
import { createActivitiesTools } from "../../tools/activities.js";
import { createActivityInsightTools } from "../../tools/activityInsights.js";
import { type ActivityFeelWriter, createActivityFeelTools } from "../../tools/feel.js";
import { createPlanTools } from "../../tools/plan.js";
import { createRaceTools } from "../../tools/races.js";
import { createRunningCalibrationTools } from "../../tools/runningCalibration.js";
import { createTrainingLoadTools } from "../../tools/trainingLoad.js";
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

【回答形态（HARD）】复盘/分析类回答必须判断先行三段式：
1. 第一句话就是定性结论 + 归因（例：「名义轻松跑，实际跑成了渐进节奏课；末段心率顶到阈值是主动加劲，不是漂移」）。
2. 中间只写支撑判断的对照数据（基线 delta、天气修正、负荷位置）。禁止用「基本盘」复述开头——距离/配速/时长 App 活动页已有；没有信息的字段直接不提；不排固定小节。
3. 结尾必给明确的行动指令（例：「明天彻底休息，周五心率压 144 以下跑回 easy」），绝不以「继续加油」这类空话收尾。
长度硬上限：常规课 ≤300 字，复杂课（变速/间歇/超长距离/异常数据）≤500 字。详见 analyze-activity skill。

【单次复盘（HARD）】凡是复盘某一次跑步，先调 get_activity_insights(labelId) 拿确定性结论再作答；available=false 或字段降级时，按 analyze-activity skill 的回退路径用现有工具自行分析，绝不编造数值。

【语言（HARD）】所有输出一律中文，包括工具调用前的进度句。调用工具前可以用一句简短的中文说明你接下来要查什么（例如“我看一下最近几堂专项课的分段”）——这句话只写你要查什么，不写结论，绝不出现英文。

涉及疲劳、负荷、恢复、状态、能否加量的问题，都必须先调用 get_daily_training_load 拿到近期负荷趋势，并结合 chronic/acute/loadRatio/form 分析后再作答；不要只凭单次跑步的感觉下结论。

行动指令：基于数据给出明确的下一步训练指令是你的职责（「明天怎么办」必须有着落）；但结构化训练计划文档的修改和生成不归你——计划工具是只读的，你可以查看和解释计划内容，也不得建议运动员手动改动计划。

能查到的事实，先自己查清楚再回答；只有确实不在数据里的东西（比如官方成绩、你当时的主观感受、天气），才向运动员确认。分段配速、后程掉速、单次训练的细节一定在 get_activity_details 里，不要问运动员。

feel 缺失时每次会话最多自然地问一次（锚点与落库规则见 analyze-activity skill）；已有值绝不重问，绝不批量提醒「有 N 次没填体感」。
    `;

/** qa 子代理使用的工具集（供测试复用）。feelWriter 缺省时不挂写工具（纯只读）。 */
export function getQaTools(store: DataProvider, feelWriter?: ActivityFeelWriter) {
  return [
    ...createActivityInsightTools(store),
    ...createPlanTools(store),
    ...createActivitiesTools(store),
    ...(feelWriter ? createActivityFeelTools(feelWriter) : []),
    ...createTrainingLoadTools(store),
    ...createRaceTools(store),
    ...createRunningCalibrationTools(store),
  ];
}

/** qa 业务节点：一个内层 ReAct agent，最终 AIMessage 写回外层 messages。 */
export function getQaAgent(store: DataProvider, config: ModelConfig, feelWriter?: ActivityFeelWriter) {
  logger.info(`creating qa agent with model ${config.name} (${config.model})`);

  // 无 deepagents FilesystemBackend 后，把 SKILL.md 正文直接内联进系统提示。
  const systemPrompt = [QA_SUBAGENT_PROMPT, loadSkillMarkdown("analyze-activity"), loadSkillMarkdown("analyze-race")].join("\n\n");

  return createAgent({
    model: buildModel(config),
    tools: getQaTools(store, feelWriter),
    systemPrompt,
    contextSchema: CoachContext,
    middleware: [createTurnScopeMiddleware(), createLoggingMiddleware("agent:qa")],
  });
}
