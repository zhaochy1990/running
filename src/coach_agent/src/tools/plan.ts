/** Read-only master and weekly plan tools backed by DataProvider. */

import type { StructuredTool } from "@langchain/core/tools";
import { mondayOnOrBefore, renderRunWorkoutSummary, weekFolder } from "@stride/contract";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type { DaySessionRow, DataProvider, MasterPlanDocument, WeeklyPlanDocument } from "../data/dataProvider.js";
import { defineCoachTools } from "./common.js";

const getMasterPlanSchema = z.object({});
const getWeeklyPlanSchema = z.object({
  weekStart: z.iso.date().describe("周起始日（周一），格式 YYYY-MM-DD，例 2026-07-20。传该周内任意一天都会归一到周一。"),
});
const getDayPlanSessionsSchema = z.object({
  date: z.iso.date().optional().describe("起始日 YYYY-MM-DD；缺省为今天。"),
  end_date: z.iso.date().optional().describe("结束日 YYYY-MM-DD（含）；缺省与 date 同天（查单日）。"),
});

export interface PlanStore {
  getMasterPlan(userId: string, day: string): Promise<MasterPlanDocument | null>;
  getWeeklyPlan(userId: string, weekName: string): Promise<WeeklyPlanDocument | null>;
  getPlanSessions(userId: string, dateFrom: string, dateTo: string): Promise<DaySessionRow[]>;
}

export class PlanToolImpl {
  constructor(private readonly store: PlanStore) {}

  async getMasterPlan(_input: z.infer<typeof getMasterPlanSchema>, runtime: CoachToolRuntime): Promise<MasterPlanDocument | null> {
    const userId = requireUserId(runtime, "get_master_plan");
    const asof = requireAsOf(runtime, "get_master_plan");
    return this.store.getMasterPlan(userId, asof);
  }

  async getWeeklyPlan(input: z.infer<typeof getWeeklyPlanSchema>, runtime: CoachToolRuntime): Promise<WeeklyPlanDocument | null> {
    const userId = requireUserId(runtime, "get_weekly_plan");
    // MySQL keys weekly plans by their Monday, so normalize the caller's
    // week-start date to the canonical Monday-Sunday folder identity.
    return this.store.getWeeklyPlan(userId, weekFolder(mondayOnOrBefore(input.weekStart)));
  }

  async getDayPlanSessions(input: z.infer<typeof getDayPlanSessionsSchema>, runtime: CoachToolRuntime): Promise<unknown> {
    const userId = requireUserId(runtime, "get_day_plan_sessions");
    const asof = requireAsOf(runtime, "get_day_plan_sessions");
    const dateFrom = input.date ?? asof;
    const dateTo = input.end_date ?? dateFrom;
    const rows = await this.store.getPlanSessions(userId, dateFrom, dateTo);
    return {
      window: { from: dateFrom, to: dateTo },
      count: rows.length,
      sessions: rows.map((row) => summarizeDaySession(row)),
      hint:
        rows.length === 0
          ? "该窗口内没有任何已保存的训练课（周计划课/自建课/手表课均无）——回答「今天练什么/有没有课」以本结果为准，不要凭对话历史断言。"
          : undefined,
    };
  }
}

/** 行投影 → LLM 友好摘要：run spec 渲染成一行课表；推送状态显式化。 */
function summarizeDaySession(row: DaySessionRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    date: row.date,
    source: row.source === "custom" ? "custom（用户自建课）" : row.source === "weekly" ? "weekly（周计划课）" : "watch（手表同步课）",
    kind: row.kind,
    name: row.name,
    pushed: row.pushed ? "已推送到手表" : "未推送",
  };
  if (row.summary) out.summary = row.summary;
  if (row.spec_json) {
    try {
      const spec = JSON.parse(row.spec_json) as { schema?: string };
      if (spec.schema === "run-workout/v1") out.workout_line = renderRunWorkoutSummary(spec as never);
    } catch {
      // spec 解析失败就只给 summary 字段，不阻塞整行。
    }
  }
  return out;
}

export function createPlanTools(store: DataProvider): StructuredTool[] {
  const impl = new PlanToolImpl(store);
  return defineCoachTools([
    {
      name: "get_master_plan",
      description: "查询用户当前激活的赛季训练计划，包括目标、阶段、里程碑与周框架。无激活计划时返回 null。",
      schema: getMasterPlanSchema,
      handler: (input, runtime) => impl.getMasterPlan(input, runtime),
    },
    {
      name: "get_weekly_plan",
      description: "查询运动员某一周（周一起算的自然周）的训练计划，包含每天训练、营养与教练备注。weekStart 指定查询周的周一，没有匹配计划时返回 null。",
      schema: getWeeklyPlanSchema,
      handler: (input, runtime) => impl.getWeeklyPlan(input, runtime),
    },
    {
      name: "get_day_plan_sessions",
      description:
        "查询某天（或日期区间）实际已保存的训练安排——含周计划课、用户自建课与手表同步课，以及每节的推送状态。回答「今天/某天练什么」「有没有课」「课保存了吗/推送到手表了吗」必须用本工具查证，不要凭对话历史断言某课是否已保存。",
      schema: getDayPlanSessionsSchema,
      handler: (input, runtime) => impl.getDayPlanSessions(input, runtime),
    },
  ]);
}

function requireUserId(runtime: CoachToolRuntime, toolName: string): string {
  const userId = runtime.context?.userId;
  if (!userId) throw new Error(`${toolName}: missing userId in runtime context`);
  return userId;
}

function requireAsOf(runtime: CoachToolRuntime, toolName: string): string {
  const asof = runtime.context?.asof;
  if (!asof) throw new Error(`${toolName}: missing asof in runtime context`);
  return asof;
}
