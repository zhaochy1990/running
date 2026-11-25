import { buildModel, getLogger } from "@stride/common";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import type { ModelConfig } from "../../config/config.js";
import type { DataProvider } from "../../data/dataProvider.js";
import { createActivitiesTools } from "../../tools/activities.js";
import { createActivityInsightTools } from "../../tools/activityInsights.js";
import { type ActivityFeelWriter, createActivityFeelTools } from "../../tools/feel.js";
import { createPlanTools } from "../../tools/plan.js";
import { createRaceCalendarSearchTools } from "../../tools/raceCalendar.js";
import { createRaceTools } from "../../tools/races.js";
import { createRecoveryTools } from "../../tools/recovery.js";
import { createRunningCalibrationTools } from "../../tools/runningCalibration.js";
import { createSyncCoverageTools } from "../../tools/syncCoverage.js";
import { createTrainingLoadTools } from "../../tools/trainingLoad.js";
import { CoachContext } from "../context.js";
import { createLoggingMiddleware } from "../middleware.js";
import { SKILLS_DIR } from "../skillLoader.js";
import { createTurnScopeMiddleware } from "../turnScope.js";

const logger = getLogger("coachAgent:qa");

// TODO: 关于跑步知识需要外接知识库
// 行动指令：基于数据给出明确的下一步训练指令是你的职责（「明天怎么办」必须有着落）；但结构化训练计划文档的修改和生成不归你——计划工具是只读的，你可以查看和解释计划内容，也不得建议运动员手动改动计划。
const QA_SUBAGENT_PROMPT = `你是 STRIDE 跑步教练的训练问答专家，你可以回答用户关于训练的问题。包括下面几类：
1. 复盘某次训练，例如“今天跑的怎么样？”，必须使用skill "analyze-activity"
2. 训练状态、疲劳与负荷（训练负荷、疲劳状态、恢复情况）
3. 跑步知识（跑步技巧、训练方法、运动科学知识）
4. 查看当前赛季计划、或某一周训练计划的内容
5. 查看/核对某天的训练安排（有没有课、课是什么、是否已保存/已推送到手表）——必须用工具 "get_day_plan_sessions" 查证后回答，不要把对话里生成过但未保存的课当成已存在的训练
6. 赛事日历信息（某场比赛的时间/城市/项目，或一段时间内有哪些比赛）——先用 "search_race_calendar" 检索，查不到就是暂无该赛事、如实告知，不要编造；要看赛道/爬升/补给/关门等细节，用检索结果里的 race_event_id 调 "get_race_calendar_detail"。制定或调整比赛执行策略不归你——那是 race_strategy 的事，让用户从赛事详情页发起。

你有下面的几个skill，
1. 当用户询问某个训练跑得怎么样的时候，先使用工具"get_activities_by_date_range"查找到对应的运动记录，然后使用skill "analyze-activity" 进行分析。
2. 当用户询问某个比赛的复盘时，使用skill "analyze-race"。
3. 当用户询问一段时间训练状态、身体状态、疲劳与负荷分布，或恢复状态（HRV / 静息心率）时，使用skill "analyze-body-status"。

当前时间以最新一条用户消息里的 timestamp 为准。

【语言（HARD）】所有输出一律中文，包括工具调用前的进度句。调用工具前可以用一句简短的中文说明你接下来要查什么（例如“我看一下最近几堂专项课的分段”）——这句话只写你要查什么，不写结论，绝不出现英文。

涉及疲劳、负荷、恢复、状态、能否加量的问题，都必须先调用 get_daily_training_load 拿到近期负荷趋势，并结合 chronic/acute/loadRatio/form 分析后再作答；不要只凭单次跑步的感觉下结论。状态/恢复/HRV/静息心率类问题先调 get_recovery_status（HRV/RHR 日序列+厂商基线，解读口径见 analyze-body-status skill），再与负荷位置交叉验证后下结论。

【数据覆盖（HARD，devops#1013）】近期问答（最近跑得怎么样、近期状态）只依据已获得的证据：回答前用 get_sync_coverage 确认近期证据窗口与分析 as-of，窗口外的日期不要当成已核实。长期结论（长期趋势、历史 PB、多年负荷、训练画像）在下述任一情况必须明确说明受限，且不得声称完整：更早历史还在后台补齐、历史补齐失败、或历史分析未发布、有证据缺项——活动记录能查到不等于长期数据完整。分析结果带 as-of 时注明「基于 X 月 X 日的数据」，跨日不要说成今天的状态。后台任务失败时如实给出原因和出路（如在同步设置里重试），禁止把失败无限描述成「整理中/还在整理」；没有证据的指标就是不可用，不要用别的数据顶替或编造。get_sync_coverage 返回 hasSession=false 时，说明该用户没有首次同步 session（老用户），按实际查到的数据正常回答，不要因此断言数据缺失。

能查到的事实，先自己查清楚再回答；只有确实不在数据里的东西（比如官方成绩、用户当时的主观感受、天气），才向运动员确认。分段配速、后程掉速、单次训练的细节一定在 get_activity_details 里，不要问运动员。

feel 与 feelNote 均缺失时每次会话最多自然地问一次（量表表格与落库规则见 analyze-activity skill）；运动员回答的原话直接经 set_activity_feel 落库，不做数值映射。任一已有值绝不重问，绝不批量提醒「有 N 次没填体感」。

不要给用户推荐后续的训练计划，恢复建议等。
`;

/** qa 子代理使用的工具集（供测试复用）。feelWriter 缺省时不挂写工具（纯只读）。 */
export function getQaTools(store: DataProvider, feelWriter?: ActivityFeelWriter) {
  return [
    // ...createActivityInsightTools(store),
    ...createPlanTools(store),
    ...createActivitiesTools(store),
    ...(feelWriter ? createActivityFeelTools(feelWriter) : []),
    ...createTrainingLoadTools(store),
    ...createRaceTools(store),
    ...createRaceCalendarSearchTools(store),
    ...createRecoveryTools(store),
    ...createRunningCalibrationTools(store),
    ...createSyncCoverageTools(store),
  ];
}

/** qa 业务节点：一个内层 deep agent，最终 AIMessage 写回外层 messages。 */
export function getQaAgent(store: DataProvider, config: ModelConfig, feelWriter?: ActivityFeelWriter) {
  logger.info(`creating qa agent with model ${config.name} (${config.model})`);

  // Skill 正文不进 system prompt：analyze-activity / analyze-race /
  // analyze-body-status 由
  // SkillsMiddleware 按需经 read_file 加载（deep agent 的 FilesystemBackend）。
  // Skill 路径是虚拟路径；不开 virtualMode 时绝对路径会逃出 rootDir 直指 OS 根。
  return createDeepAgent({
    model: buildModel(config),
    tools: getQaTools(store, feelWriter),
    systemPrompt: QA_SUBAGENT_PROMPT,
    contextSchema: CoachContext,
    middleware: [createTurnScopeMiddleware(), createLoggingMiddleware("agent:qa")],
    backend: new FilesystemBackend({ rootDir: SKILLS_DIR, virtualMode: true }),
    skills: ["/analyze-activity/", "/analyze-race/", "/analyze-body-status/"],
  });
}
