/**
 * Race calendar search tools —— QA 子代理的公开赛历检索（devops#812）。
 *
 * 列表 + 详情两件套：search_race_calendar 按条件查已发布赛事摘要，
 * get_race_calendar_detail 按检索返回的 id 取完整内容聚合（数据源与
 * race_strategy 的 turn-scope 工具同源）。赛历是 published=1 的公开数据、
 * 问答只读不落库，允许模型传参检索；比赛策略的「会话锚定单场」防混入
 * 约束属另一场景，见 raceStrategyContext.ts。
 */

import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type { DataProvider } from "../data/dataProvider.js";
import { defineCoachTools } from "./common.js";

const searchSchema = z.object({
  keyword: z.string().min(1).max(64).optional().describe("名称关键词（子串匹配，中英文均可，如「杭州」「Hangzhou」）"),
  city: z.string().min(1).max(32).optional().describe("城市，需带行政后缀精确匹配（如「杭州市」）；不确定后缀时改用 keyword 检索"),
  dateFrom: z.iso.date().optional().describe("比赛日期下界 YYYY-MM-DD（含），缺省=今天"),
  dateTo: z.iso.date().optional().describe("比赛日期上界 YYYY-MM-DD（含），缺省=dateFrom + 90 天（dateFrom 缺省时即今天起 90 天）"),
  itemType: z.string().min(1).max(32).optional().describe("项目类型（Marathon / HalfMarathon / 10Km / Trail / Ultra 等）"),
  limit: z.number().int().positive().max(20).optional().describe("最多返回几条，缺省 10，比赛日期升序"),
});

const detailSchema = z.object({
  race_event_id: z.number().int().positive().describe("赛事 id，必须来自 search_race_calendar 的返回，不要凭记忆编造"),
});

class RaceCalendarSearchToolImpl {
  constructor(private readonly store: Pick<DataProvider, "searchRaceCalendar" | "getRaceCalendarContext">) {}

  async search(input: z.infer<typeof searchSchema>, runtime: CoachToolRuntime) {
    const asof = runtime.context?.asof;
    if (!asof) {
      throw new Error("search_race_calendar: missing asof in runtime context");
    }
    return this.store.searchRaceCalendar({
      asofDate: asof,
      ...(input.keyword !== undefined ? { keyword: input.keyword } : {}),
      ...(input.city !== undefined ? { city: input.city } : {}),
      ...(input.dateFrom !== undefined ? { dateFrom: input.dateFrom } : {}),
      ...(input.dateTo !== undefined ? { dateTo: input.dateTo } : {}),
      ...(input.itemType !== undefined ? { itemType: input.itemType } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  }

  async detail(input: z.infer<typeof detailSchema>) {
    const context = await this.store.getRaceCalendarContext(input.race_event_id);
    if (context === null) {
      return { race_event_id: input.race_event_id, found: false, reason: "race not found or unpublished" };
    }
    return { ...context, found: true };
  }
}

/**
 * 构建赛历检索工具（注入数据存储）。`asof` 从 `runtime.context` 读取，绝
 * 不作为工具入参——缺省日期窗由实现层按 asof 锚定。
 *
 * @example
 * ```ts
 * tools: [...createRaceCalendarSearchTools(store)]
 * ```
 */
export function createRaceCalendarSearchTools(store: Pick<DataProvider, "searchRaceCalendar" | "getRaceCalendarContext">): StructuredTool[] {
  const impl = new RaceCalendarSearchToolImpl(store);
  return defineCoachTools([
    {
      name: "search_race_calendar",
      description:
        "检索已发布赛事日历：某场比赛的时间/城市/项目，或一段时间内有哪些比赛（如「杭州马拉松什么时候开跑」「11 月有什么全马」）。" +
        "返回摘要列表（race_event_id/名称/日期/城市/项目）；查不到就是暂无该赛事，不要编造。要看赛道/爬升/补给/关门等细节，用返回的 race_event_id 调 get_race_calendar_detail。",
      schema: searchSchema,
      handler: (input, runtime) => impl.search(input, runtime),
    },
    {
      name: "get_race_calendar_detail",
      description:
        "按 race_event_id 获取一场赛事的完整内容聚合：基本信息、赛道文字、爬升、海拔剖面、难点、补给站、关门点与城市/气候背景。" +
        "race_event_id 必须来自 search_race_calendar 的返回。found=false 表示赛事不存在或未发布。",
      schema: detailSchema,
      handler: (input) => impl.detail(input),
    },
  ]);
}
