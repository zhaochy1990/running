/**
 * Race / history tools —— 供教练回看运动员的比赛与长距离表现，判断历史比赛
 * 是否“跑崩”，通过 DataProvider 读取活动与 PB。
 *
 * 与 activities / trainingLoad 工具同构：领域类（纯、可单测）+ `defineCoachTools`
 * 适配器。`userId` 从 `runtime.context` 读取，绝不作为工具入参。
 */

import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type { DataProvider, PersonalBest, RaceEffort } from "../data/dataProvider.js";
import { defineCoachTools } from "./common.js";

const getRaceHistorySchema = z.object({
  minDistanceKm: z
    .number()
    .positive()
    .optional()
    .describe("返回记录的最小距离（公里），缺省 4.5。只是防极小课噪音的地板，不筛选比赛——比赛身份由 races 表与 session_class 判定。"),
  limit: z.number().int().positive().optional().describe("最多返回几条，缺省 15，最近在前"),
});

type GetRaceHistoryInput = z.infer<typeof getRaceHistorySchema>;

const getPersonalBestsSchema = z.object({});

class RaceToolImpl {
  constructor(private readonly store: DataProvider) {}

  async getRaceHistory(input: GetRaceHistoryInput, runtime: CoachToolRuntime): Promise<RaceEffort[]> {
    const userId = runtime.context?.userId;
    const asof = runtime.context?.asof;
    if (!userId) {
      throw new Error("get_race_history: missing userId in runtime context");
    }
    if (!asof) {
      throw new Error("get_race_history: missing asof in runtime context");
    }
    return this.store.getRaceHistory(userId, {
      asOfDate: asof,
      ...(input.minDistanceKm !== undefined ? { minDistanceKm: input.minDistanceKm } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  }

  async getPersonalBests(_input: z.infer<typeof getPersonalBestsSchema>, runtime: CoachToolRuntime): Promise<PersonalBest[]> {
    const userId = runtime.context?.userId;
    const asof = runtime.context?.asof;
    if (!userId) {
      throw new Error("get_personal_bests: missing userId in runtime context");
    }
    if (!asof) {
      throw new Error("get_personal_bests: missing asof in runtime context");
    }
    return this.store.getPersonalBests(userId, asof);
  }
}

/**
 * 构建比赛/历史工具（注入数据存储）。
 *
 * @example
 * ```ts
 * tools: [...createRaceTools(store)]
 * ```
 */
export function createRaceTools(store: DataProvider): StructuredTool[] {
  const impl = new RaceToolImpl(store);
  return defineCoachTools([
    {
      name: "get_race_history",
      description:
        "回看运动员确认过的比赛记录（最近在前），含距离、用时、平均配速、平均/最大心率与主观感受 feel。" +
        "比赛身份来自两个显式信号（race detection 的 races 表、活动分类器 session_class='race'），长距离训练课不会混入。",
      schema: getRaceHistorySchema,
      handler: (input, runtime) => impl.getRaceHistory(input, runtime),
    },
    {
      name: "get_personal_bests",
      description: "获取运动员各标准距离（5K/10K/HM/FM 等）的个人最好成绩（用时秒 + 取得日期）。",
      schema: getPersonalBestsSchema,
      handler: (input, runtime) => impl.getPersonalBests(input, runtime),
    },
  ]);
}
