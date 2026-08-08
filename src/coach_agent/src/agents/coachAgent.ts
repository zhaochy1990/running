/**
 * Coach — Deep Agents supervisor with intent routing + state/context + memory.
 *
 * Routing: the supervisor reads the athlete's message, decides intent, and either
 * handles it (memory) or delegates to a subagent via the built-in `task` tool.
 *   - training_question  → delegate to the `training_question` subagent (qaTools)
 *   - long-term goal      → remember_athlete_fact (store)
 *   - recall              → recall_athlete_facts (store)
 *   - other               → deflect
 *
 * State/context/memory (same as before):
 *   - `contextSchema { userId }` → request-scoped; injected into the supervisor
 *     prompt by `dynamicSystemPromptMiddleware`, and forwarded to the subagent in
 *     the delegation so its tools get the right userId.
 *   - `checkpointer` → per-thread conversation memory.
 *   - `store`        → cross-session long-term memory.
 */

import { createDeepAgent, FilesystemBackend } from "deepagents";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { z } from "zod/v4";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentConfig, type CoachAgentConfig, type ModelConfig } from "../config/config.js";
import { buildResponsesModel } from "./common.js";
import { memoryTools } from "./memory.js";
import { masterPlanTools } from "./master_plan/tools.js";
import { createRaceTools } from "../tools/races.js";
import { createPlanTools } from "../tools/plan.js";
import { askUserQuestionTool } from "../tools/askUserQuestions.js";
import type { ToolRuntime } from "langchain";
import { getQaSubagent } from "./qa/agent.js";
import { createLoggingMiddleware } from "./middleware.js";
import type { StrideDataStore } from "../persistence/index.js";
import { getCoachSubagent } from "./weekly_plan/agent.js";

export const CoachContext = z.object({
  userId: z.string(),
});
export type CoachToolRuntime = ToolRuntime<unknown, typeof CoachContext>;

// Skills live next to the compiled agents (`dist/agents/skills/**`, copied from
// `src/agents/skills/**` by `npm run build`). Root the deep agent's filesystem
// backend here so subagents can `read_file` a SKILL.md via SkillsMiddleware.
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', "skills");

console.log(dirname(fileURLToPath(import.meta.url)));
console.log(`[coachAgent] SKILLS_DIR=${SKILLS_DIR}`);

const MASTER_SUBAGENT_PROMPT = [
  "你是 STRIDE 跑步教练的赛季计划专家。",
  "",
  "运动员要【生成新赛季计划】时，先做背景分析，再谈计划：",
  "1. 用 get_race_history 回看运动员过往的比赛/长距离表现；用 get_personal_bests 拿到各距离 PB 作参照。",
  "2. 判断有没有某次比赛明显“跑崩”：feel 为 awful/bad，或配速明显慢于同距离 PB / 近期水平，或用时远超预期。",
  "3. 一旦发现疑似跑崩、但从数据看不出原因，必须用 ask_user_question 向运动员追问当时的具体情况——",
  "   给出候选项帮助作答，例如：心肺/呼吸受限、腿部肌肉抽筋、补给/能量不足（撞墙）、前程配速过快、天气高温、伤病、其他。",
  "   一次只问一个核心问题。拿到回答后，把原因纳入计划考量（如抽筋→加强力量与电解质；撞墙→强化长距离与糖原策略；心肺→加强有氧/阈值）。",
  "4. 若历史比赛表现正常、无需澄清，就不要为追问而追问。",
  "",
  "查看现有赛季/总体计划用 get_master_plan；形成调整草案用 propose_master_adjustment。",
  "只依据工具数据说话。",
].join("\n");

const ORCHESTRATOR_PROMPT = [
  "你是 STRIDE 跑步教练的总协调。读运动员这条消息，判断意图并处理（训练相关一律委派给对应子专家，你自己没有查/改计划的工具）：",
  "- 训练问答（今天/最近跑得怎么样、训练状态、疲劳与负荷）→ 用 task 委派给 training_question 子专家。",
  "- 查看或调整某一周计划（本周/某周、把周三改成…）→ 用 task 委派给 weekly_plan 子专家。",
  "- 查看/生成/调整赛季或总体计划（阶段、里程碑、生成新赛季计划、把基础期延长…）→ 用 task 委派给 master_plan 子专家。",
  "- 运动员表达长期目标/计划（如“下个月想测10k”）→ 用 remember_athlete_fact 存长期记忆；问“以前说过什么目标”→ recall_athlete_facts。",
  "- 与跑步训练无关（天气、闲聊）→ 礼貌说明你只负责跑步训练相关的问题。",
  "委派时在任务描述里带上运动员原话；把子专家/工具的结果转达给运动员。",
].join("\n");

export async function createCoachAgent(store: StrideDataStore, config: CoachAgentConfig) {
  const modelConfig = getAgentConfig(config, "orchestrator");
  const model = buildResponsesModel(modelConfig);

  const qaSubagent = getQaSubagent(store, getAgentConfig(config, "qa"));
  const weeklySubagent = getCoachSubagent(store, getAgentConfig(config, "weekly_plan"));

  const masterSubagent = {
    name: "master_plan",
    description: "查看或调整赛季/总体训练计划（阶段、里程碑、周期）；生成新赛季计划前会回看历史比赛并在必要时向运动员追问。",
    systemPrompt: MASTER_SUBAGENT_PROMPT,
    tools: [...createPlanTools(store).filter((tool) => tool.name === "get_master_plan"), ...masterPlanTools.slice(1), ...createRaceTools(store), askUserQuestionTool],
    model: buildResponsesModel(getAgentConfig(config, "master_plan")),
    middleware: [createLoggingMiddleware("agent:master_plan")],
  };

  return createDeepAgent({
    model,
    systemPrompt: ORCHESTRATOR_PROMPT,
    tools: memoryTools,
    subagents: [qaSubagent, weeklySubagent, masterSubagent],
    contextSchema: CoachContext,
    middleware: [createLoggingMiddleware("agent")],
    backend: new FilesystemBackend({ rootDir: SKILLS_DIR }),
    checkpointer: new MemorySaver(),
    store: new InMemoryStore(),
  });
}
