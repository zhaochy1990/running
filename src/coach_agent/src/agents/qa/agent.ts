import { getLogger } from "@stride/common";
import type { ModelConfig } from "../../config/config.js";
import type { DataProvider } from "../../data/dataProvider.js";
import { createActivitiesTools } from "../../tools/activities.js";
import { createRaceTools } from "../../tools/races.js";
import { createRunningCalibrationTools } from "../../tools/runningCalibration.js";
import { createTrainingLoadTools } from "../../tools/trainingLoad.js";
import { buildChatModel, buildResponsesModel } from "../common.js";
import { createLoggingMiddleware } from "../middleware.js";
import { createTurnScopeMiddleware } from "../turnScope.js";

const logger = getLogger("coachAgent:qa");

// TODO: 关于跑步知识需要外接知识库
export function getQaSubagent(store: DataProvider, config: ModelConfig) {
  const activitiesTools = createActivitiesTools(store);
  const trainingLoadTools = createTrainingLoadTools(store);
  const raceTools = createRaceTools(store);
  const runningCalibrationTools = createRunningCalibrationTools(store);

  const QA_SUBAGENT_PROMPT = `你是 STRIDE 跑步教练的训练问答专家，你可以回答用户关于训练的问题。包括下面几类：
1. 今天/最近跑得怎么样？（今天的跑步数据、最近的训练状态）
2. 训练状态、疲劳与负荷（训练负荷、疲劳状态、恢复情况）
3. 跑步知识（跑步技巧、训练方法、运动科学知识）

工具与数据：
- get_activities_by_date_range：返回最近若干条运动的清单（含 provenance）。每条只有汇总字段、不含 laps 分段；truncated=true 表示区间内还有更多被截断；默认最多最近 30 条。回答“今天/最近跑得怎么样”时，围绕 asof 查最近 7 天即可，不要拉过宽区间。先拿清单，需要分段再走下一个工具。
- get_activity_details(labelId)：返回单条运动的完整明细，含 laps 分段（每公里/每圈）。需要分析间歇课、配速拆解、分段变化时，用清单里拿到的 labelId 调它。
- get_daily_training_load：返回 available、stride_training_load 与 provenance；包含每天的 STRIDE 长期负荷 chronicLoad、短期负荷 acuteLoad、负荷比 loadRatio、form=chronic−acute。available=false 时必须说明 missing_reason。
- get_personal_bests：拿标准距离的个人最好成绩。
- get_running_calibration：拿 STRIDE 计算的乳酸阈值心率、阈值速度、心率区间与配速区间。

只要问题涉及疲劳、负荷、恢复、状态、能否加量，都必须先调用 get_daily_training_load 拿到近期负荷趋势，并结合 chronic/acute/loadRatio/form 分析后再作答；不要只凭单次跑步的感觉下结论。

你不对运动员的训练计划进行修改或调整，也不提供个性化训练建议。你只回答运动员关于训练的问题，并且只依据工具数据说话。
    `;

  logger.info(`creating qa subagent with model ${config.name} (${config.model})`);

  return {
    name: "training_question",
    description: "回答关于运动员自己训练的问题：今天/最近跑得怎么样、训练状态、疲劳与负荷、跑步知识。",
    systemPrompt: QA_SUBAGENT_PROMPT,
    tools: [...activitiesTools, ...trainingLoadTools, ...raceTools, ...runningCalibrationTools],
    model: buildChatModel(config),
    middleware: [createTurnScopeMiddleware(), createLoggingMiddleware("agent:qa")],
    // Skill loaded via SkillsMiddleware from the deep agent's FilesystemBackend
    // (rooted at `dist/agents/skills/` in coachAgent.ts). The agent reads the
    // full SKILL.md on demand via read_file. Path is relative to that root.
    skills: ["/analyze-activity/"],
  };
}
