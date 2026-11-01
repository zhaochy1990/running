import type { RunWorkout } from "@stride/contract";
import { easyMidOfZones, hasQualitySegment, type PaceZones } from "../derive.js";
import type { ContentWeekRow } from "../doctrine.js";
import { LR_EVE_MAX_KM, sessionKm } from "../validators.js";
import { courseDose, type DoseCoefficients } from "./dose.js";
import type { CalendarDay, LoadSeriesPoint } from "./scheduler.js";

/**
 * L4b 排位门 P1-P7（devops#799 校验节；contract.md §6.3）：对排位后的日历判定，
 * 输入=L4b 构造产物（calendar/load_series/sessions）。门挂=排位无解上浮
 * （调度器已先行确定性修复；到这里仍挂=课包问题，带原因重生成 L4a）。
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
}

/**
 * P7 有氧份额·阶段递进动态下限（2026-11-01 用户拍板专项化周期原则）：
 * 有氧份额随比赛临近单调递减——专项性原则（SAID）+ 教练 8 周基准实证
 * （前期 ~75-80% → 峰值 MP 周 ~45% → 赛周 ~30%）。绝对下限 35%。
 */
const AEROBIC_FLOOR: Record<string, number> = {
  recovery: 0.85,
  foundation: 0.76,   // 38 案例包络校准值（实测下缘 78.5%−2pct 余量）
  early_quality: 0.75,
  transition_quality: 0.65,
  final_quality: 0.55, // 前半段（≥4 周离赛）——专项过渡，仍保有氧底座
};
/** final_quality 后半段（<4 周离赛）的递减下限——MP 主导，全程模拟合法。 */
const FQ_LATE_FLOOR = 0.40;
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
  const qualityWds = calendar
    .filter((d) => d.sessions.some(quality))
    .map((d) => (new Date(`${d.date}T00:00:00Z`).getUTCDay() + 6) % 7)
    .sort((a, b) => a - b);
  const adjacent = qualityWds.filter((wd, i) => i > 0 && wd - qualityWds[i - 1]! === 1);
  checks.push({ id: "P2 质量课不相邻", pass: adjacent.length === 0, detail: adjacent.length === 0 ? "全过" : `相邻质量日周内位 ${adjacent.join(",")}` });

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

  // P5 双练准入（>1 节/日 仅当周量 >110km；判定归本段）。
  const doubles = calendar.filter((d) => d.sessions.length > 1);
  const p5Ok = doubles.length === 0 || row.totalKm > DOUBLE_ADMISSION_KM;
  checks.push({
    id: "P5 双练准入",
    pass: p5Ok,
    detail: doubles.length === 0 ? "无双练日" : `${doubles.length} 个双练日，周量 ${row.totalKm}km${p5Ok ? ">" : "≤"}${DOUBLE_ADMISSION_KM}`,
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
    checks.push({ id: "P7 有氧份额", pass: !unknown && share >= floor, detail: unknown ? "里程不可知" : `${(share * 100).toFixed(0)}% vs ≥${(floor * 100).toFixed(0)}%${row.phase === "final_quality" ? (input.weeksToRace != null && input.weeksToRace < FQ_LATE_WEEKS ? "（后半段递减）" : "（前半段）") : ""}` });
  }

  return checks;
}
