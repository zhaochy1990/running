/**
 * 存量 master_plan.content → RollingMasterInput 适配器（#858 PR-A Round 2）。
 *
 * content 是 worker master handler 落库的 v2 形状（masterPlanToContent 产物 +
 * #859 政策包四段 + #858 availability），滚动 job 从 DB 原样读出后在此重解析：
 * policy/skeleton/anchor 走契约 zod 单源（坏行=解析错误，调用方转 permanent
 * error，不静默降级）；race 取 content.goal（distance 透传，target_time 为
 * "finish_only" 时由 runRollingProjection 的目标时间门拦下）。
 */

import {
  LoadPlanSchema,
  MasterPlanAnchorSchema,
  masterPlanAvailabilityDetail,
  PhaseDivisionIntentSchema,
  type RollingMasterInput,
  type RollingStrengthAvailability,
  WEEKDAY_VALUES,
  type Weekday,
  type WeeklyPlan,
  WeeklyPlanSchema,
  weekFolder,
} from "@stride/contract";
import type { z } from "zod/v4";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 政策包段解析：zod 单源校验 + 明确的段名错误（调用方据此转 permanent error）。 */
function parsePolicySegment<S extends z.ZodType>(name: string, schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`storedContent.${name} 非法：${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
  return parsed.data;
}

function requiredString(content: Record<string, unknown>, key: string): string {
  const value = content[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`storedContent 缺少合法 ${key}`);
  return value;
}

/**
 * 存量 weekly_plan 行 content → 周文档（#858 PR-C 下半提取共享）：Go 落库时
 * （validateAppliedWeeklyPlan）剥掉 `schema`/`week_name` 两个身份键，读回侧
 * 按行身份（weekStart 周一）回填后再过严格校验——detect/夜检/换因 job 共用。
 */
export function storedWeeklyDocOf(raw: unknown, weekStart: string): WeeklyPlan {
  const record = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  return WeeklyPlanSchema.parse({
    schema: "weekly-plan/v1",
    week_name: weekFolder(weekStart),
    ...record,
  });
}

/**
 * content → RollingMasterInput。`lastGeneratedWeek` 由调用方计算（快照有课周 ∪
 * 已落库 weekly 行的最大周号）——本适配器只见得到 content，不知道 weekly 落库状态。
 */
export function fromStoredContent(args: { content: Record<string, unknown>; masterPlanId: string; lastGeneratedWeek: number }): RollingMasterInput {
  const { content } = args;
  const goal = content.goal;
  if (typeof goal !== "object" || goal === null || Array.isArray(goal)) throw new Error("storedContent.goal 不是对象");
  const goalRecord = goal as Record<string, unknown>;
  const raceDate = goalRecord.race_date;
  const targetTime = goalRecord.target_time;
  const distance = goalRecord.distance;
  if (typeof raceDate !== "string" || !DAY_RE.test(raceDate)) throw new Error("storedContent.goal.race_date 非法");
  // v2 快照把完赛目标的 target_time 存成 "finish_only"——滚动只支持时间目标，
  // 在此给出明确错误（比让 runRollingProjection 的目标时间门报不可解析更早）。
  if (typeof targetTime !== "string" || targetTime.length === 0 || targetTime === "finish_only") {
    throw new Error("storedContent.goal.target_time 非法（滚动仅支持时间目标）");
  }
  if (distance !== "FM" && distance !== "HM") throw new Error("storedContent.goal.distance 非法（须 FM/HM）");

  const availability = content.availability;
  if (typeof availability !== "object" || availability === null || Array.isArray(availability)) {
    throw new Error("storedContent 缺 availability（老 content 无滚动可用性段）");
  }
  const weeklyRunDaysMax = (availability as Record<string, unknown>).weekly_run_days_max;
  if (typeof weeklyRunDaysMax !== "number" || !Number.isInteger(weeklyRunDaysMax) || weeklyRunDaysMax < 1 || weeklyRunDaysMax > 7) {
    throw new Error("storedContent.availability.weekly_run_days_max 非法");
  }
  // #222 力量偏好读回：旧计划缺段=null（继续只出跑课，buildWeeklyDocs 批内首周
  // 提示补选）；半残段同按未设置处理（宁可少排不排脏课）。
  const strength = parseStoredStrength(availability as Record<string, unknown>);

  // devops#1043：约束排课的可用度明细（禁跑日/日内窗口/双练许可）；
  // 存量行只有天数上限时 detail 缺省——续排沿用可确认的约束，具体日期按未知处理
  const detail = masterPlanAvailabilityDetail(availability);
  const totalWeeks = content.total_weeks;
  if (typeof totalWeeks !== "number" || !Number.isInteger(totalWeeks) || totalWeeks < 1) throw new Error("storedContent.total_weeks 非法");

  const policy = parsePolicySegment("policy", PhaseDivisionIntentSchema, content.policy);
  const skeleton = parsePolicySegment("skeleton", LoadPlanSchema, content.skeleton);
  const anchor = parsePolicySegment("anchor", MasterPlanAnchorSchema, content.anchor);

  return {
    masterPlanId: args.masterPlanId,
    planStartMonday: requiredString(content, "start_date"),
    totalWeeks,
    race: {
      name: requiredString(goalRecord, "race_name"),
      date: raceDate,
      targetTime,
      distance,
    },
    availability: { weeklyRunDaysMax, strength, ...(detail != null ? { detail } : {}) },
    policy,
    skeleton,
    anchor,
    lastGeneratedWeek: args.lastGeneratedWeek,
  };
}

const WEEKDAYS = WEEKDAY_VALUES as readonly string[];

/** unknown[] → 星期名数组（去重）；任一元素不是合法星期名返回 null。 */
function weekdayList(value: unknown): Weekday[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && WEEKDAYS.includes(item))) return null;
  return [...new Set(value as Weekday[])];
}

/**
 * content.availability 的力量段 → RollingStrengthAvailability；null=未设置（旧
 * 计划缺段，或半残段——宁可按未设置处理也不排脏课）。四个必填字段齐且合法
 * 才算已设置；unavailable_days 缺省为空。0 次=显式关闭（合法已设置态，此时
 * 力量日可为空——表单关闭时清空）。
 */
function parseStoredStrength(availability: Record<string, unknown>): RollingStrengthAvailability | null {
  const { strength_sessions_per_week: sessions, strength_available_days: days, allows_double_sessions: doubles } = availability;
  if (typeof sessions !== "number" || !Number.isInteger(sessions) || sessions < 0) return null;
  if (typeof doubles !== "boolean") return null;
  const availableDays = weekdayList(days);
  if (availableDays === null) return null;
  return {
    sessionsPerWeek: sessions,
    availableDays,
    allowsDoubleSessions: doubles,
    unavailableDays: weekdayList(availability.unavailable_days) ?? [],
  };
}
