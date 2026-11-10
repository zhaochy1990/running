/**
 * 调整窗口推导（#858 PR-C，纯函数）：偏差周判定后，决定「重生成当前批次
 * 剩余周」的窗口——**只改已可见的剩余周，不出新周**（边界出新块归
 * generate_rolling_block）。
 *
 * 语义（票面定稿）：窗口=明日 → 当前周所在块末 ∩ 已生成段末（lastGeneratedWeek
 * ∩ 已落库 weekly 行）。起点=事件周+1 与「明日所在周」取大——事件周是完整周
 * （≤当前周−1），正常即当前周；窗口含当前周时，已过日期由追赶冻结
 * （freezePastSessions，date<明天删会话）兜住。终点三重夹：当前周所在块末
 * （3+1 mesocycle 界）、lastGeneratedWeek（不出新周）、已落库 weekly 行最大周
 * （只替换已可见行）。终点<起点 → no_op（当前周已是批次末/无剩余周/赛季结束）。
 */
import type { LoadPlan } from "@stride/contract";
import { addDays, shanghaiDay } from "@stride/contract";
import { currentWeekOf, type RollingWindow } from "../window.js";

/** 存量 weekly 行的最小引用（窗口推导用周号；diff 用 km，见 adjust.ts）。 */
export interface ExistingWeekRef {
  weekStart: string;
  week: number;
  km: number;
}

export type AdjustWindowDecision = { kind: "window"; window: RollingWindow } | { kind: "no_op"; reason: string };

/** 事件周周一 → 计划内周号（对不上计划轴=非法事件）。 */
export function weekNumberOf(planStartMonday: string, weekStart: string): number {
  return Math.floor((Date.parse(`${weekStart}T00:00:00Z`) - Date.parse(`${planStartMonday}T00:00:00Z`)) / (7 * 86_400_000)) + 1;
}

/**
 * 调整窗口判定（带 no_op 原因）。skeleton 用重展开后的新骨架（块界与 rolling
 * 同源）；existingWeeks 为已落库 weekly 行（空=无可见行可改）。
 */
export function evaluateAdjustWindow(opts: {
  skeleton: LoadPlan;
  planStartMonday: string;
  asOf: string;
  lastGeneratedWeek: number;
  /** 偏差事件周周一（WeekDeviation.weekStart）。 */
  eventWeekStart: string;
  existingWeeks: ExistingWeekRef[];
}): AdjustWindowDecision {
  const { skeleton, planStartMonday, asOf, lastGeneratedWeek, existingWeeks } = opts;
  const weeks = skeleton.weeks;
  if (weeks.length === 0) return { kind: "no_op", reason: "skeleton 无周行，无调整可做" };
  const raceWeek = weeks.find((week) => week.role === "race")?.week ?? weeks.at(-1)!.week;
  const currentWeek = currentWeekOf(planStartMonday, asOf);
  if (currentWeek > raceWeek) return { kind: "no_op", reason: `当前第 ${currentWeek} 周已越过比赛周（第 ${raceWeek} 周），赛季已结束` };

  const eventWeek = weekNumberOf(planStartMonday, opts.eventWeekStart);
  if (eventWeek < 1) return { kind: "no_op", reason: `事件周 ${opts.eventWeekStart} 不在计划轴上（planStart=${planStartMonday}）` };
  // 起点=事件周+1 与「明日所在周」取大（周日触发的明日=下周一；窗口含当前周
  // 时由追赶冻结处理已过日期）。
  const tomorrowWeek = currentWeekOf(planStartMonday, addDays(shanghaiDay(asOf), 1));
  const startWeek = Math.max(eventWeek + 1, tomorrowWeek);

  if (existingWeeks.length === 0) return { kind: "no_op", reason: "无已落库 weekly 行，无可见周可调整" };
  const maxExistingWeek = Math.max(...existingWeeks.map((row) => row.week));
  if (maxExistingWeek < startWeek) {
    return { kind: "no_op", reason: `当前第 ${currentWeek} 周已是当前批次末（已见周至第 ${maxExistingWeek} 周，无可调整的剩余周）` };
  }
  if (lastGeneratedWeek < startWeek) {
    return { kind: "no_op", reason: `课表已生成至第 ${lastGeneratedWeek} 周，无可调整的剩余周（出新块归滚动生成）` };
  }

  // 终点三重夹：当前周所在块末 ∩ lastGeneratedWeek ∩ 已落库行最大周。
  const currentWeekRow = weeks.find((week) => week.week === currentWeek);
  const block =
    currentWeekRow === undefined
      ? undefined
      : (skeleton.blocks.find((candidate) => currentWeek >= candidate.start_week && currentWeek <= candidate.end_week) ??
        skeleton.blocks.find((candidate) => candidate.block === currentWeekRow.block));
  const blockEnd = block?.end_week ?? raceWeek;
  const endWeek = Math.min(blockEnd, lastGeneratedWeek, maxExistingWeek);
  if (endWeek < startWeek) {
    return { kind: "no_op", reason: `调整窗口无效（第 ${startWeek} 周 > 第 ${endWeek} 周；当前周已是批次末，出新块归滚动生成）` };
  }

  const window: RollingWindow = {
    startWeek,
    endWeek,
    // 窗口含当前周（进行中）→ 追赶冻结语义生效（date<明天删会话）。
    mode: startWeek === currentWeek ? "catch_up" : "boundary",
    reason: `偏差调整（事件周=第 ${eventWeek} 周）：重生成第 ${startWeek}-${endWeek} 周（当前批次剩余周，只改已可见周、不出新周）`,
  };
  return { kind: "window", window };
}
