/** Bounded race-strategy context tools over the read-only DataProvider. */

import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type { DataProvider } from "../data/dataProvider.js";
import { defineCoachTools } from "./common.js";

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
