import { type LoadPlan, mondayOnOrBefore, shanghaiDay } from "@stride/contract";

/**
 * 滚动批窗计算（#858 PR-A Round 1，纯函数）：决定「这次滚动生成第几周到第几
 * 周」。批=生成粒度=块（3+1 mesocycle 执行层）；final_quality 例外整段（含
 * taper，spec 拍板）——专项期叙事一体，拆块会把大彩排与减量弧切开。
 *
 * 触发语义（用户练到存量最后生成周）：currentWeek < lastGeneratedWeek = 存量
 * 课表还没用完，无事可做（no_op）；currentWeek === lastGeneratedWeek = 边界
 * 触发生成下一块；currentWeek > lastGeneratedWeek = 掉队追赶（从当前周起，
 * 块前段不回补——已过日期排课无意义）。
 */

export interface RollingWindow {
  startWeek: number;
  endWeek: number;
  mode: "boundary" | "catch_up";
  reason: string;
}

/** asOf → 计划内周号（第 1 周=planStartMonday 那周）。 */
export function currentWeekOf(planStartMonday: string, asOf: string): number {
  const monday = mondayOnOrBefore(shanghaiDay(asOf));
  return Math.floor((Date.parse(`${monday}T00:00:00Z`) - Date.parse(`${planStartMonday}T00:00:00Z`)) / (7 * 86_400_000)) + 1;
}

type WindowDecision = { kind: "window"; window: RollingWindow } | { kind: "no_op"; reason: string };

/**
 * 批窗判定（带 no_op 原因）：computeRollingWindow 的可观测内核——projection
 * 主入口用它拿 no_op 的中文原因，测试用 computeRollingWindow 钉行为。
 */
export function evaluateRollingWindow(opts: { skeleton: LoadPlan; planStartMonday: string; asOf: string; lastGeneratedWeek: number }): WindowDecision {
  const { skeleton, planStartMonday, asOf, lastGeneratedWeek } = opts;
  const weeks = skeleton.weeks;
  if (weeks.length === 0) return { kind: "no_op", reason: "skeleton 无周行，无滚动可做" };
  const raceWeek = weeks.find((week) => week.role === "race")?.week ?? weeks.at(-1)!.week;
  const currentWeek = currentWeekOf(planStartMonday, asOf);
  if (currentWeek > raceWeek) return { kind: "no_op", reason: `当前第 ${currentWeek} 周已越过比赛周（第 ${raceWeek} 周），赛季滚动结束` };
  if (lastGeneratedWeek >= raceWeek) return { kind: "no_op", reason: `课表已生成至比赛周（第 ${lastGeneratedWeek} 周 ≥ 第 ${raceWeek} 周），全量完成` };
  if (currentWeek < lastGeneratedWeek)
    return {
      kind: "no_op",
      reason: `当前第 ${currentWeek} 周早于最后生成周（第 ${lastGeneratedWeek} 周），存量课表未用尽，未到滚动边界`,
    };

  const next = Math.max(lastGeneratedWeek + 1, currentWeek);
  if (next > raceWeek) return { kind: "no_op", reason: `下一待生成周（第 ${next} 周）已越过比赛周（第 ${raceWeek} 周）` };
  const nextWeek = weeks.find((week) => week.week === next);
  if (nextWeek === undefined) return { kind: "no_op", reason: `第 ${next} 周不在骨架周行内` };

  // final_quality 整段（含 taper）；其余按 next 所在块取块内区间，起点夹到 next
  //（掉队追赶从 next 起，块前段不回补）。
  let startWeek: number;
  let endWeek: number;
  if (nextWeek.canonical === "final_quality") {
    startWeek = next;
    endWeek = raceWeek;
  } else {
    const block = skeleton.blocks.find((b) => next >= b.start_week && next <= b.end_week);
    const blockStart = block?.start_week ?? weeks.find((week) => week.block === nextWeek.block)?.week ?? next;
    const blockEnd = block?.end_week ?? [...weeks].reverse().find((week) => week.block === nextWeek.block)?.week ?? next;
    startWeek = Math.max(blockStart, next);
    endWeek = Math.min(blockEnd, raceWeek);
  }
  if (startWeek > endWeek) return { kind: "no_op", reason: `批窗无效（第 ${startWeek} 周 > 第 ${endWeek} 周）` };

  const mode: RollingWindow["mode"] = currentWeek > lastGeneratedWeek ? "catch_up" : "boundary";
  const reason =
    mode === "boundary"
      ? `第 ${currentWeek} 周为存量课表最后生成周，边界触发：滚动生成下一块（第 ${startWeek}-${endWeek} 周${nextWeek.canonical === "final_quality" ? "，final_quality 整段含 taper" : ""}）`
      : `当前第 ${currentWeek} 周已越过最后生成周（第 ${lastGeneratedWeek} 周），掉队追赶：从第 ${startWeek} 周起生成至第 ${endWeek} 周（块前段不回补${nextWeek.canonical === "final_quality" ? "；final_quality 整段含 taper" : ""}）`;
  return { kind: "window", window: { startWeek, endWeek, mode, reason } };
}

/** 批窗计算公开入口：无事可做返回 null（原因走 evaluateRollingWindow）。 */
export function computeRollingWindow(opts: { skeleton: LoadPlan; planStartMonday: string; asOf: string; lastGeneratedWeek: number }): RollingWindow | null {
  const decision = evaluateRollingWindow(opts);
  return decision.kind === "window" ? decision.window : null;
}
