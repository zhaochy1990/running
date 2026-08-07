/**
 * weekly_plan specialist — mock tools (view + propose adjustment).
 *
 * Write operations produce a DRAFT proposal (applied=false) — the confirm/apply
 * gate lands later. Mock data for now.
 */

import { tool, type ToolRuntime } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachContext } from "../coachAgent.js";

const getWeekPlanSchema = z.object({
  week: z.string().optional().describe("哪一周，如“本周”“下周”，缺省本周"),
});

const getWeekPlan = tool(
  async ({ week }: z.infer<typeof getWeekPlanSchema>, runtime: ToolRuntime<unknown, typeof CoachContext>) => {
    const userId = runtime.context?.userId;
    console.log(`[mock] get_week_plan user=${userId} week=${week ?? "本周"}`);
    return {
      week: week ?? "2026-07-27 ~ 2026-08-02（本周）",
      weekly_km: 58,
      days: [
        { day: "周一", session: "休息 / 力量 40min" },
        { day: "周二", session: "间歇 6×800m @ 3:40/km" },
        { day: "周三", session: "节奏跑 6km @ 4:30/km" },
        { day: "周四", session: "轻松跑 8km @ 5:20/km" },
        { day: "周五", session: "休息" },
        { day: "周六", session: "长跑 24km @ 5:10/km" },
        { day: "周日", session: "恢复跑 6km" },
      ],
    };
  },
  {
    name: "get_week_plan",
    description: "获取运动员某一周的训练计划（每日课表、周里程）",
    schema: getWeekPlanSchema,
  },
);

const proposeWeeklyAdjustmentSchema = z.object({
  request: z.string().describe("运动员要求的调整，如“把周三改成轻松跑”"),
});

const proposeWeeklyAdjustment = tool(
  async ({ request }: z.infer<typeof proposeWeeklyAdjustmentSchema>, runtime: ToolRuntime<unknown, typeof CoachContext>) => {
    const userId = runtime.context?.userId;
    console.log(`[mock] propose_weekly_adjustment user=${userId} request=${request}`);
    return {
      summary: `本周计划调整草案（需运动员确认后才生效）：${request}`,
      changes: [`按运动员要求调整周三课表；里程与本周总量保持不变。原始请求：${request}`],
      applied: false,
    };
  },
  {
    name: "propose_weekly_adjustment",
    description: "针对本周计划形成一个调整草案（不直接生效，等运动员确认）",
    schema: proposeWeeklyAdjustmentSchema,
  },
);

export const weeklyPlanTools = [getWeekPlan, proposeWeeklyAdjustment];
