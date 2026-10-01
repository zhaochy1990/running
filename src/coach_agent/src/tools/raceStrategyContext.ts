/** Bounded race-strategy context tools over the read-only DataProvider. */

import type { StructuredTool } from "@langchain/core/tools";
import { getLogger } from "@stride/common";
import * as z from "zod/v4";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import { masterPlanGoalFromDocument, raceGoalQuestion } from "../agents/race_strategy/goalQuestion.js";
import type { DataProvider } from "../data/dataProvider.js";
import { defineCoachTool, defineCoachTools } from "./common.js";

const logger = getLogger("raceStrategyContextTools");

/**
 * race target 从服务端校验过的 turn scope（<coach_turn_scope>）读取，不由模型
 * 传参——模型无法把别的赛事塞进上下文。无 race target 时工具直接报错，让
 * 子代理转而向运动员说明入口。
 */
function raceEventIdFromTarget(runtime: CoachToolRuntime): number {
  const target = runtime.context?.target;
  const raceEventId = target?.kind === "race" ? target.race_event_id : undefined;
  if (typeof raceEventId !== "number" || !Number.isInteger(raceEventId) || raceEventId <= 0) {
    throw new Error("get_race_calendar_context: no race target on this conversation (enter from the race detail page)");
  }
  return raceEventId;
}

class RaceStrategyContextTool {
  constructor(private readonly store: Pick<DataProvider, "getRaceCalendarContext">) {}

  async getRaceCalendarContext(_input: z.infer<typeof getRaceCalendarContextSchema>, runtime: CoachToolRuntime) {
    const raceEventId = raceEventIdFromTarget(runtime);
    const context = await this.store.getRaceCalendarContext(raceEventId);
    if (context === null) {
      return { race_event_id: raceEventId, found: false, reason: "race not found or unpublished" };
    }
    return { ...context, found: true };
  }
}

/**
 * 一个有界只读工具：赛事内容聚合（赛道/难点/关门/补给站/城市）。策略代理各
 * 调用一次，禁止拿逐条活动替代。目标成绩不查数据——只来自运动员自己的消息
 * （目标定多少是运动员的决策，策略内容也不做能力分析）。
 */
export function createRaceStrategyContextTools(store: Pick<DataProvider, "getRaceCalendarContext">): StructuredTool[] {
  const impl = new RaceStrategyContextTool(store);
  return defineCoachTools([
    {
      name: "get_race_calendar_context",
      description:
        "获取当前会话目标赛事的内容聚合：基本信息、赛道文字、爬升、海拔剖面、难点、补给站、关门点与城市/气候背景（无输入参数，赛事取自会话 target）。" +
        "found=false 表示赛事不存在或未发布。",
      schema: getRaceCalendarContextSchema,
      handler: (input, runtime) => impl.getRaceCalendarContext(input, runtime),
    },
  ]);
}

const getRaceCalendarContextSchema = z.object({});

/** 模型用这个工具名声明「本轮要追问目标成绩」；race_strategy 节点按它检测并替换回复。 */
export const ASK_USER_FOR_GOAL_TOOL = "ask_user_for_goal";

class AskUserForGoalTool {
  constructor(private readonly store: Pick<DataProvider, "getRaceTarget" | "getRaceCalendarContext" | "getMasterPlan">) {}

  /**
   * 追问文案在这里确定性生成：候选目标按序查两处——运动员唯一 active 的
   * race_goal 与 active 赛季训练计划的目标（master plan content.goal），比赛
   * 日、项目词汇、目标时间都对上本场才进候选；单候选带目标确认、双候选列
   * 出来让运动员选、无候选一句话直问。模型只负责原样转达——弱模型自己组织
   * 追问会夹带大段赛道内容。任何数据异常都落到直问，绝不因 goal 查询挂掉
   * 这一轮；master plan 查询单独兜底，计划侧故障不拖垮 race_goal 候选。
   */
  async askUserForGoal(_input: z.infer<typeof askUserForGoalSchema>, runtime: CoachToolRuntime) {
    const target = runtime.context?.target;
    const raceTarget = target?.kind === "race" ? target : undefined;
    const raceEventId = raceTarget?.race_event_id;
    const itemType = raceTarget?.item_type;
    if (runtime.context === undefined || raceEventId === null || raceEventId === undefined || itemType === null || itemType === undefined) {
      return { question: raceGoalQuestion({ goal: null, race: null, itemType: "" }) };
    }
    try {
      const [goal, race, plan] = await Promise.all([
        this.store.getRaceTarget(runtime.context.userId),
        this.store.getRaceCalendarContext(raceEventId),
        this.store.getMasterPlan(runtime.context.userId, runtime.context.asof).catch(() => null),
      ]);
      return { question: raceGoalQuestion({ goal, planGoal: masterPlanGoalFromDocument(plan), race, itemType }) };
    } catch (error) {
      logger.warn({ err: error }, "ask_user_for_goal lookup failed; falling back to the direct question");
      return { question: raceGoalQuestion({ goal: null, race: null, itemType: "" }) };
    }
  }
}

/** 追问目标成绩的专用工具：返回应原样转达给运动员的一句话文案。 */
export function createAskUserForGoalTool(store: Pick<DataProvider, "getRaceTarget" | "getRaceCalendarContext" | "getMasterPlan">): StructuredTool {
  const impl = new AskUserForGoalTool(store);
  return defineCoachTool({
    name: ASK_USER_FOR_GOAL_TOOL,
    description:
      "当对话里还没有运动员明确给出的目标完赛时间时调用一次：系统会查运动员已存的比赛目标与赛季训练计划的目标，返回应当原样转达给运动员的一句话追问文案（question 字段；不要改写、不要补充赛道/天气等任何其它内容）。无输入参数。",
    schema: askUserForGoalSchema,
    handler: (input, runtime) => impl.askUserForGoal(input, runtime),
  });
}

const askUserForGoalSchema = z.object({});
