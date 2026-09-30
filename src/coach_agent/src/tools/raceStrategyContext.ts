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
  constructor(private readonly store: Pick<DataProvider, "getRaceCalendarContext" | "getPerformanceBaseline">) {}

  async getRaceCalendarContext(_input: z.infer<typeof getRaceCalendarContextSchema>, runtime: CoachToolRuntime) {
    const raceEventId = raceEventIdFromTarget(runtime);
    const context = await this.store.getRaceCalendarContext(raceEventId);
    if (context === null) {
      return { race_event_id: raceEventId, found: false, reason: "race not found or unpublished" };
    }
    return { ...context, found: true };
  }

  async getPerformanceBaseline(_input: z.infer<typeof getPerformanceBaselineSchema>, runtime: CoachToolRuntime) {
    const userId = runtime.context?.userId;
    const asof = runtime.context?.asof;
    if (!userId) {
      throw new Error("get_performance_baseline: missing userId in runtime context");
    }
    if (!asof) {
      throw new Error("get_performance_baseline: missing asof in runtime context");
    }
    return this.store.getPerformanceBaseline(userId, asof);
  }
}

/**
 * 两个有界只读工具：赛事内容聚合（赛道/难点/关门/补给站/城市）与运动员成绩
 * 基线（预测/能力 L4/校准）。策略代理各调用一次，禁止拿逐条活动替代。
 */
export function createRaceStrategyContextTools(store: Pick<DataProvider, "getRaceCalendarContext" | "getPerformanceBaseline">): StructuredTool[] {
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
    {
      name: "get_performance_baseline",
      description:
        "获取运动员成绩基线：各距离完赛预测（race_predictions）、最新能力 L4（综合分与全马/半马估计）、乳酸阈值与配速/心率区间校准。" +
        "缺项以 null/空数组返回，需在策略依据里声明。",
      schema: getPerformanceBaselineSchema,
      handler: (input, runtime) => impl.getPerformanceBaseline(input, runtime),
    },
  ]);
}

const getRaceCalendarContextSchema = z.object({});
const getPerformanceBaselineSchema = z.object({});
