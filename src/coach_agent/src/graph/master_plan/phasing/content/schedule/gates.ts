import type { RunWorkout } from "@stride/contract";
import { LONG_RUN_MAX_KM, LONG_RUN_MAX_MIN, longRunMaxKm } from "../../sessionCaps.js";
import { easyMidOfZones, hasQualitySegment, type PaceZones } from "../derive.js";
import type { ContentWeekRow } from "../doctrine.js";
import { E_DURATION_NORMAL_BAND, LR_EVE_MAX_KM, sessionKm, weekdayOf } from "../validators.js";
import { type AvailabilityConstraints, doubleSessionAllowed, windowLimitOf } from "./availability.js";
import { courseDose, courseMinutes, type DoseCoefficients, elapsedMinutes } from "./dose.js";
import type { CalendarDay, LoadSeriesPoint } from "./scheduler.js";

/**
 * L4b 排位门 P1-P9（devops#799 校验节 + #1043 P8 + #1054 P9；contract.md §6.3）：对
 * 排位后的日历判定，输入=L4b 构造产物（calendar/load_series/sessions）。门挂=排位
 * 无解上浮（调度器已先行确定性修复；到这里仍挂=课包问题，带原因重生成 L4a）。
 */

export interface ScheduleCheck {
  id: string;
  pass: boolean;
  detail: string;
}

export interface GateInput {
  calendar: CalendarDay[];
  loadSeries: LoadSeriesPoint[];
  row: ContentWeekRow;
  daysMax: number;
  raceDate: string | null;
  coefficients: DoseCoefficients;
  /** 离赛周数（本周=1，赛前一周=2；final_quality P7 动态下限用）。 */
  weeksToRace?: number | null;
  /** 上周日（批界前的已知边界日）是否含质量课——P2 跨周判定（devops#1043）。 */
  previousDayQuality?: boolean;
  /**
   * 用户可用度（devops#1043 可跑日 → P8；devops#1054 双练许可 → P5、日内时窗 →
   * P9）；缺省=未声明（可跑日未知时 P8 不判、不受时窗限制）。
   */
  availability?: AvailabilityConstraints;
}

/**
 * P7 有氧份额·阶段递进动态下限（2026-11-01 用户拍板专项化周期原则）：
 * 有氧份额随比赛临近单调递减——专项性原则（SAID）+ 教练 8 周基准实证
 * （前期 ~75-80% → 峰值 MP 周 ~45% → 赛周 ~30%）。绝对下限 35%。
 */
const AEROBIC_FLOOR: Record<string, number> = {
  recovery: 0.85,
  foundation: 0.76, // 38 案例包络校准值（实测下缘 78.5%−2pct 余量）
  early_quality: 0.75,
  transition_quality: 0.65,
  final_quality: 0.35, // 2026-11-09 用户拍板：专项期有氧可压到 30% 级（峰值 MP 周教练基准 ~45%、
  // 用户明示 30% 可接受）——不严卡下限，防伤底线交给绝对下限；与 C17 ≤65% 上限
  // 的窗口恢复 30pt（旧 55%/40% 与 C17 在峰值周只剩 10pt，19 周验收 W13-15 批
  // 9 轮全败的唯一死因）。
};
/** final_quality 后半段（<4 周离赛）——已并入统一 35%（2026-11-09 拍板），常量保留兼容。 */
const FQ_LATE_FLOOR = 0.35;
/** 绝对下限：任何阶段不低于此（有氧跑的恢复/防伤功能不可替代）。 */
const AEROBIC_ABS_FLOOR = 0.35;
/** final_quality 前后半段分界（离赛周数）。 */
const FQ_LATE_WEEKS = 4;
const AEROBIC_FLOOR_ROLE_CUT: Record<string, number> = { progress: 0, absorb: 0.09, taper: 0.02, race: 0 };

/** P2 相邻判定容差（无——相邻=周内位差恰 1）。 */
const LR_EVE_KM_TOL = 0.1;

/** P6 比值 cap（越界=调度无解上浮；scheduler 修复与门判定共用单源）。 */
export const RATIO_CAP = 1.3;
/** P6 舍入容差（ratio 取整 2 位的粒度）。 */
export const RATIO_CAP_EPS = 0.01;
/** P5 双练准入：周量 >110km 才允许双练日（判定归本段）。 */
export const DOUBLE_ADMISSION_KM = 110;

/** 长跑里程比较容差（km）：上限向下取整到 0.1km，恰好压线的时长处方折算后可能略高。 */
const LR_KM_TOLERANCE = 0.05;

export function scheduleGates(input: GateInput): ScheduleCheck[] {
  const { calendar, loadSeries, row, daysMax, raceDate, coefficients } = input;
  const zones = row.zones;
  const sessions = calendar.flatMap((d) => d.sessions);
  const checks: ScheduleCheck[] = [];
  const quality = (w: RunWorkout) => hasQualitySegment(w, zones) || (raceDate != null && w.date === raceDate);

  // P1 训练日 ≤availability（按 date 去重；双练日算一天——C4 同款判据移入本段）。
  const daySet = new Set(sessions.map((s) => s.date));
  checks.push({ id: "P1 训练日", pass: daySet.size <= daysMax, detail: `${daySet.size} 天 vs ≤${daysMax}` });

  // P2 质量课不相邻日（相邻日独立质量课=违规；LR 内嵌质量按判定表参与）。
  // 质量课恢复间隔同样检查周界（devops#1043）：上周日质量课/比赛 ↔ 本周一
  // 质量课背靠背=违规。赛周豁免：周五/周六比赛的赛前激活课落在周一（赛前 5 天
  // 位），紧接上周日带质量尾段的减量长跑是既有赛周位型（票面「既有赛周例外」，
  // 激活窗内也没有别的位置）——不按跨周背靠背判，由审计提示。
  const qualityWds = calendar
    .filter((d) => d.sessions.some(quality))
    .map((d) => (new Date(`${d.date}T00:00:00Z`).getUTCDay() + 6) % 7)
    .sort((a, b) => a - b);
  const adjacent = qualityWds.filter((wd, i) => i > 0 && wd - qualityWds[i - 1]! === 1);
  const crossWeekAdjacent = input.previousDayQuality === true && raceDate == null && qualityWds.includes(0);
  checks.push({
    id: "P2 质量课不相邻",
    pass: adjacent.length === 0 && !crossWeekAdjacent,
    detail:
      adjacent.length > 0 ? `相邻质量日周内位 ${adjacent.join(",")}` : crossWeekAdjacent ? "周一质量课与上周日质量课/比赛背靠背（跨周恢复间隔不足）" : "全过",
  });

  // P3 LR 周日 + 前日轻量（周六全 E 且合计 ≤8km 或休）。
  const lrs = sessions.filter((s) => s.type === "LR");
  const lrWd = lrs.length === 1 ? (new Date(`${lrs[0]!.date}T00:00:00Z`).getUTCDay() + 6) % 7 : null;
  const sat = calendar[5]!;
  // E 带中点：周六课 recovery time 步折算锚（sessionKm 同源；E 带缺失传 null）
  const eMid = easyMidOfZones(zones);
  const satKm = sat.sessions.reduce((s, w) => s + (sessionKm(w, eMid) ?? 0), 0);
  const satLight = sat.sessions.every((w) => w.type === "E") && (sat.sessions.length === 0 || satKm <= LR_EVE_MAX_KM + LR_EVE_KM_TOL);
  const p3Ok = row.longRunKm == null ? lrs.length === 0 : lrWd === 6 && satLight;
  checks.push({
    id: "P3 LR周日+前日轻量",
    pass: p3Ok,
    detail:
      row.longRunKm == null
        ? `赛周 lr=null，${lrs.length} 节 LR`
        : lrWd === 6
          ? `周六 ${sat.sessions.length === 0 ? "休" : `${satKm.toFixed(1)}km E`}`
          : `LR 周内位 ${lrWd}`,
  });

  // P4 比赛课=比赛日（赛周行：比赛日恰一节=最大里程课且无他课）。
  if (raceDate != null) {
    const raceDay = calendar.find((d) => d.date === raceDate);
    const raceDaySessions = raceDay?.sessions ?? [];
    checks.push({
      id: "P4 比赛课=比赛日",
      pass: raceDaySessions.length === 1 && quality(raceDaySessions[0]!),
      detail: `${raceDate} ${raceDaySessions.length} 节`,
    });
  }

  // P5 双练准入：>1 节/日 仅当周量 >110km 且用户许可（devops#1054 把许可补进门里——
  // 此前只在排位阶段查，换日等修复路径造出的双练日会漏过）；判定归本段。
  const doubles = calendar.filter((d) => d.sessions.length > 1);
  const doublesAllowed = doubleSessionAllowed(row.totalKm, DOUBLE_ADMISSION_KM, input.availability);
  checks.push({
    id: "P5 双练准入",
    pass: doubles.length === 0 || doublesAllowed,
    detail:
      doubles.length === 0
        ? "无双练日"
        : `${doubles.length} 个双练日，周量 ${row.totalKm}km${row.totalKm > DOUBLE_ADMISSION_KM ? ">" : "≤"}${DOUBLE_ADMISSION_KM}${
            input.availability?.allowsDoubleSessions === false ? "，一天两练未获许可" : ""
          }`,
  });

  // P6 比值 cap 1.3（本周逐点；越界=调度无解——调度器修复后仍挂才到这）。
  // 比赛日豁免：马拉松本身=目标事件非可调度负荷，当日剂量必然冲高（生产实际
  // 亦然）——cap 约束的是可排日程，赛前 taper 已由衰减保证。
  const overs = loadSeries.filter((p) => p.date !== raceDate && (p.ratio ?? 0) > RATIO_CAP + RATIO_CAP_EPS);
  const worst = loadSeries.filter((p) => p.date !== raceDate).reduce((a, b) => ((b.ratio ?? 0) > (a?.ratio ?? 0) ? b : a), loadSeries[0]);
  checks.push({
    id: "P6 比值cap",
    pass: overs.length === 0,
    detail: overs.length === 0 ? `max=${worst?.ratio ?? "—"}` : `${overs[0]!.date} r=${overs[0]!.ratio}`,
  });

  // P7 有氧份额·阶段递进动态下限（2026-11-01 专项化周期拍板）：
  // 阶段基础下限 × final_quality 内离赛周数递减（≥4 周=前半段 55%，<4 周=后半段 40%）
  // × 角色微调（absorb +5pct 回弹）。绝对下限 35%。赛周豁免。
  if (row.role === "race") {
    checks.push({ id: "P7 有氧份额", pass: true, detail: "赛周豁免" });
  } else {
    const phaseFloor = AEROBIC_FLOOR[row.phase] ?? 0.66;
    let floor = phaseFloor;
    // final_quality 内按离赛周数递减
    if (row.phase === "final_quality" && input.weeksToRace != null && input.weeksToRace < FQ_LATE_WEEKS) {
      floor = FQ_LATE_FLOOR;
    }
    // 角色微调（absorb 周有氧略回弹）
    floor = floor - (AEROBIC_FLOOR_ROLE_CUT[row.role] ?? 0);
    // 绝对下限
    floor = Math.max(floor, AEROBIC_ABS_FLOOR);
    let aero = 0;
    let total = 0;
    let unknown = false;
    for (const w of sessions) {
      const d = courseDose(w, zones, coefficients);
      if (d.km == null) {
        unknown = true;
        break;
      }
      aero += d.aerobicKm;
      total += d.km;
    }
    const share = total > 0 ? aero / total : 0;
    // 上限归内容层 C17（2026-11-02 拍板后挪层）：排位层改不了课包成分，份额上限
    // 在 P 门挂=结构性无解上浮（模板兜底被误伤实证）；C17 在课包阶段查、LLM 带
    // 违规重试可修。
    checks.push({
      id: "P7 有氧份额",
      pass: !unknown && share >= floor,
      detail: unknown
        ? "里程不可知"
        : `${(share * 100).toFixed(0)}% vs ≥${(floor * 100).toFixed(0)}%${row.phase === "final_quality" ? (input.weeksToRace != null && input.weeksToRace < FQ_LATE_WEEKS ? "（后半段递减）" : "（前半段）") : ""}`,
    });
  }

  // P8 可跑日（devops#1043）：全部课落在用户可跑日（禁跑日/可用窗口之外的
  // 日子无课）；具体日期未知（存量只有天数上限）时不判。比赛日是固定事件，
  // 不受周内可跑日约束。
  const availableWeekdays = input.availability?.availableWeekdays ?? null;
  if (availableWeekdays != null) {
    const allowed = new Set(availableWeekdays);
    const offDays = [...new Set(sessions.filter((s) => s.date !== raceDate && !allowed.has(weekdayOf(s.date))).map((s) => s.date))].sort();
    checks.push({ id: "P8 可跑日", pass: offDays.length === 0, detail: offDays.length === 0 ? "全过" : `课落在不可跑日：${offDays.join(",")}` });
  }

  // P9 单课时长（devops#1054）：① 日内时窗——每节课的墙钟时长（含休息）装得进所在日
  // 最长的一段连续时窗（未声明=不限；休息时长不可知的课保证不了装得下，同样挂）；
  // ② 最终硬校验复核按能力派生的两个上限（sessionCaps）——长跑 ≤ 180 分钟 @ 当周
  // E 配速（至多 40km），日常有氧 ≤ 90min（跑步时间步，与 C9 同口径）。比赛日是目标
  // 事件不是训练课，不受限（同 P6/P8 的豁免）。
  const over: string[] = [];
  for (const { date, sessions } of calendar) {
    if (date === raceDate) continue;
    const window = windowLimitOf(input.availability, weekdayOf(date));
    for (const workout of sessions) {
      if (window != null) {
        const minutes = elapsedMinutes(workout, eMid);
        if (minutes == null) over.push(`${date} ${workout.name} 休息时长不可知——须写成 time_s 的 rest 步`);
        else if (minutes > window) over.push(`${date} ${workout.name}≈${Math.round(minutes)}min 超出可训练时段（时窗 ${window}min）`);
      }
      if (workout.type === "LR") {
        const km = sessionKm(workout, eMid);
        const capKm = eMid == null ? LONG_RUN_MAX_KM : longRunMaxKm(eMid);
        // 文案用课型+实测值，不带课名：课名常自带里程（「长跑 34.7km」）会重复
        if (km != null && km > capKm + LR_KM_TOLERANCE)
          over.push(`${date} 长跑 ${Math.round(km * 10) / 10}km 超出长跑上限 ${capKm}km（${LONG_RUN_MAX_MIN} 分钟 @ E 配速，至多 ${LONG_RUN_MAX_KM}km）`);
      } else if (workout.type === "E") {
        const eMinutes = courseMinutes(workout);
        if (eMinutes != null && eMinutes > E_DURATION_NORMAL_BAND[1])
          over.push(`${date} 有氧课 ${Math.round(eMinutes)}min 超出日常有氧上限 ${E_DURATION_NORMAL_BAND[1]}min`);
      }
    }
  }
  checks.push({ id: "P9 单课时长", pass: over.length === 0, detail: over.length === 0 ? "全过" : over.join("; ") });
  return checks;
}
