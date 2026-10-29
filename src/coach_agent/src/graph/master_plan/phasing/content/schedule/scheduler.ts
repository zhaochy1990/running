import { normalizeRunWorkout, type RunWorkout } from "@stride/contract";
import { hasQualitySegment } from "../derive.js";
import type { ContentRaceContext, ContentWeekRow } from "../doctrine.js";
import { E_DURATION_INTERVAL_BAND, E_DURATION_NORMAL_BAND, LR_EVE_MAX_KM, weekdayOf } from "../validators.js";
import { COEFFICIENT_VERSION, courseDose, DEFAULT_DOSE_COEFFICIENTS, type DoseCoefficients } from "./dose.js";
import { DOUBLE_ADMISSION_KM, RATIO_CAP, RATIO_CAP_EPS, type ScheduleCheck, scheduleGates } from "./gates.js";

/**
 * L4b 波浪调度器（devops#799，contract.md §6 / daniels-l4-content.md §6）：
 * L4a 课包（无 day、E=槽位+时长带）+ L3 周行（km/lr/q 硬边界）+ 生产 PMC 当日
 * 快照种子 → 周内逐日贪心排位（谷排刺激/高时消化/LR 周日位型先验/周六 LR 前日
 * 轻量）→ E 槽位实例化（位置定带、water-fill 收敛 C1）→ 日历 + load_series
 * （exp-pmc-7-42 与生产同款常数）。
 *
 * 层内仲裁（修复经济学）：排位失败先确定性局部修复（缩 E 时长/周六置休/剪余量
 * 槽位/双练准入）仍无解才上浮带原因——本段绝不直接触发 LLM 重生成（由 L4 编排
 * 在违规重试环里重生成 L4a，generate.ts）。
 *
 * POC（wave-poc.mjs）行为对照 + 两处丢课 bug 修复：谷阈值动态化（剩余质量课
 * ≥剩余合法日=到期强制排）+ 强制窗口含周五。
 */

// ── 课包类型（L4a 产物；结构课 blocks 与 run-workout/v1 同形、无日期）──

type V1Block = RunWorkout["blocks"][number];

export interface StructuredCourse {
  kind: "course";
  name: string;
  /** 主刺激类型（LR=位型长跑课；E 一律走槽位形态不入此类）。 */
  type: "M" | "T" | "I" | "R" | "LR";
  purpose: string;
  note: string | null;
  blocks: V1Block[];
}

/** E 槽位：L4a 只声明量纲意图（时长带+strides），分钟数由本段实例化。 */
export interface ESlotCourse {
  kind: "e-slot";
  /** normal=普通 E 日 60-90min；interval=间隔日 30-60min（最终带按落位判）。 */
  band: "normal" | "interval";
  strides: boolean;
  purpose: string | null;
}

export type PlannedCourse = StructuredCourse | ESlotCourse;

export interface WeekBag {
  week: number;
  courses: PlannedCourse[];
}

// ── 输出契约（contract.md §6 定稿）──

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export type DayLabel = (typeof DAY_LABELS)[number];

export interface CalendarDay {
  week: number;
  date: string;
  day: DayLabel;
  sessions: RunWorkout[];
}

/** 逐日负荷序列点（exp-pmc-7-42 与生产 daily_training_load 同款常数）。 */
export interface LoadSeriesPoint {
  date: string;
  week: number;
  loadPt: number;
  atl: number;
  ctl: number;
  /** 日负荷比（atl/ctl）；chronic=0 时 null。 */
  ratio: number | null;
  sessions: string[];
}

export interface LoadMeta {
  model: "exp-pmc-7-42";
  seed: { acute: number; chronic: number; source: string };
  coefficient_version: string;
}

export interface WeekSchedule {
  week: number;
  sessions: RunWorkout[];
  calendar: CalendarDay[];
  loadSeries: LoadSeriesPoint[];
  /** P1-P7（gates.ts）。 */
  checks: ScheduleCheck[];
  repairs: string[];
}

export interface ScheduleResult {
  weeks: WeekSchedule[];
  loadMeta: LoadMeta;
  /** 全部周 P 门全绿（最终 C 校验由编排层跑 validators）。 */
  ok: boolean;
  /** 无解上浮原因（空=无）；编排层并入 L4a 重试违规清单。 */
  failures: string[];
}

/** PMC 当日快照（生产 daily_training_load.acute_load/chronic_load 直读；不自算种子）。 */
export interface PmcState {
  acute: number;
  chronic: number;
}

/** 与生产 trainingload/daily.go 同款常数（kAcute=1−e^(−1/7)、kChronic=1−e^(−1/42)）。 */
const K_ACUTE = 1 - Math.exp(-1 / 7);
const K_CHRONIC = 1 - Math.exp(-1 / 42);

export function advancePmc(pmc: PmcState, dose: number): PmcState {
  return { acute: pmc.acute + K_ACUTE * (dose - pmc.acute), chronic: pmc.chronic + K_CHRONIC * (dose - pmc.chronic) };
}

// ── 调度上下文与常量 ──

export interface ScheduleContext {
  rows: ContentWeekRow[];
  planStartMonday: string;
  race: ContentRaceContext;
  athlete: { weeklyRunDaysMax: number };
  /** 生产 PMC 当日快照（fitness_state.atl/ctl）。 */
  pmcSeed: PmcState;
  coefficients?: DoseCoefficients;
}

/** scheduleOnly（R0 夜复盘微调）单周上下文。 */
export interface SingleWeekContext {
  /** 该周周一 ISO date（日历映射锚）。 */
  weekMonday: string;
  race: ContentRaceContext | null;
  athlete: { weeklyRunDaysMax: number };
  coefficients?: DoseCoefficients;
}

/** 贪心谷阈值（比值 ≤θ 排下一刺激/≥θ 只消化——POC 手拍值，行为对照通过）。 */
const VALLEY_RATIO = 1.02;
/** P6 修复轮上限（挪日与缩 E 各计一轮）。 */
const P6_REPAIR_PASSES = 2;
/** E 分钟取整粒度（30s）。 */
const E_MINUTE_ROUND_S = 30;

const round2 = (x: number) => Math.round(x * 100) / 100;

const dateOf = (weekMonday: string, weekday: number): string => {
  const d = new Date(`${weekMonday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weekday);
  return d.toISOString().slice(0, 10);
};

/** 周一锚归一（防误传非周一日期：回拨到该周周一）。 */
function mondayOf(date: string): string {
  const wd = weekdayOf(date);
  return wd === 0 ? date : dateOf(date, -wd);
}

const easyMidOf = (row: ContentWeekRow): number => {
  const [lo, hi] = row.zones.easy ?? [null, null];
  if (lo == null || hi == null) throw new Error(`schedule: 第${row.week}周 easy 带缺失`);
  return (lo + hi) / 2;
};

// ── E 槽位实例化 ──

/** E 课落位语素（时长带与 purpose 模板一一对应；C9 分层口径单源）。 */
type EFlavor = "normal" | "interval" | "lrEve" | "shake" | "regen";

/** 落位时长带（分钟）：间隔日/再生周=短带；LR 前日=km 帽无下限；赛周激活窗=短帽。 */
function eBandOf(flavor: EFlavor, row: ContentWeekRow): [number, number] {
  const eMid = easyMidOf(row);
  switch (flavor) {
    case "interval":
    case "regen":
      return [...E_DURATION_INTERVAL_BAND] as [number, number];
    case "shake":
      return [0, E_DURATION_INTERVAL_BAND[1]];
    case "lrEve":
      return [0, Math.min(E_DURATION_INTERVAL_BAND[1], (LR_EVE_MAX_KM * eMid) / 60)];
    case "normal":
      return [...E_DURATION_NORMAL_BAND] as [number, number];
  }
}

function ePurpose(flavor: EFlavor, minutes: number, strides: boolean, slotPurpose: string | null, raceName: string | null): string {
  const base =
    slotPurpose ??
    (flavor === "interval"
      ? `间隔日短有氧：${Math.round(minutes)} 分钟 E 配速促进恢复、保持腿部活性，为下一节质量课蓄力。`
      : flavor === "lrEve"
        ? `LR 前日轻量：${Math.round(minutes)} 分钟短 E（≤8km）保持腿部活性，为明日长跑蓄力，不追距离。`
        : flavor === "shake"
          ? `赛前激活：${Math.round(minutes)} 分钟短 E 慢跑保持腿部活性与血流量，为${raceName ?? "比赛"}减量到位。`
          : flavor === "regen"
            ? `恢复周轻松课：${Math.round(minutes)} 分钟 E 配速促进恢复，保持腿部活性，不追强度。`
            : `有氧轻松课：${Math.round(minutes)} 分钟 E 配速巩固有氧地基，全程可交谈。`);
  return strides ? `${base}加 4×100m strides 保持速度触感。` : base;
}

/** E 槽位 → v1 课（work time_s @E 带；strides 走独立 repeat 块；30s 取整）。 */
function materializeE(slot: ESlotCourse, flavor: EFlavor, minutes: number, date: string, row: ContentWeekRow, raceName: string | null): RunWorkout {
  const [lo, hi] = row.zones.easy ?? [null, null];
  const eMid = easyMidOf(row);
  let seconds = Math.max(E_MINUTE_ROUND_S, Math.round((minutes * 60) / E_MINUTE_ROUND_S) * E_MINUTE_ROUND_S);
  // LR 前日轻量帽按 km 终钳（30s 取整在慢带上可越 8km——P3 门按课实际里程判）
  if (flavor === "lrEve") seconds = Math.min(seconds, Math.floor((LR_EVE_MAX_KM * eMid) / E_MINUTE_ROUND_S) * E_MINUTE_ROUND_S);
  const easy = { kind: "pace_s_km" as const, low: lo, high: hi };
  return normalizeRunWorkout({
    name: `E ${Math.round(seconds / 60)}min${slot.strides ? "+strides" : ""}`,
    date,
    type: "E",
    purpose: ePurpose(flavor, seconds / 60, slot.strides, slot.purpose, raceName),
    note: slot.strides ? "strides 每组之后充分恢复再起下一组，不求快只求顺。" : null,
    blocks: [
      { repeat: 1, steps: [{ step_kind: "work", duration: { kind: "time_s", value: seconds }, target: easy, note: null, hr_cap_bpm: null }] },
      ...(slot.strides
        ? [
            {
              repeat: 4,
              steps: [
                {
                  step_kind: "work" as const,
                  duration: { kind: "distance_m" as const, value: 100 },
                  target: { kind: "open" as const, low: null, high: null },
                  note: null,
                  hr_cap_bpm: null,
                },
              ],
            },
          ]
        : []),
    ],
  });
}

// ── 结构课物化与剂量 ──

function materializeCourse(course: StructuredCourse, date: string): RunWorkout {
  return normalizeRunWorkout({ name: course.name, date, type: course.type, purpose: course.purpose, note: course.note, blocks: course.blocks });
}

const doseOf = (workout: RunWorkout, row: ContentWeekRow, coefficients: DoseCoefficients) => courseDose(workout, row.zones, coefficients);

// ── 排位（周内位决策）──

interface Placement {
  /** 周内位 → 已排课（每格可多课=双练日）。 */
  dayCourses: PlannedCourse[][];
  repairs: string[];
  /** 结构课排不下（daysMax 容量不足等）=课包无解，上浮原因。 */
  failures: string[];
}

/** 比赛周：比赛课（最大里程结构课）钉比赛日（P4）、其余结构课=M 激活（赛前 2-3 天）、E 槽填赛前窗。 */
function placeRaceWeek(bag: WeekBag, row: ContentWeekRow, coefficients: DoseCoefficients, raceWd: number, daysMax: number): Placement {
  const dayCourses: PlannedCourse[][] = Array.from({ length: 7 }, (): PlannedCourse[] => []);
  const repairs: string[] = [];
  const failures: string[] = [];
  const structured = bag.courses.filter((c): c is StructuredCourse => c.kind === "course");
  const slots = bag.courses.filter((c): c is ESlotCourse => c.kind === "e-slot");
  const raceCourse = [...structured].sort(
    (a, b) => (doseOf(materializeCourse(b, "2000-01-03"), row, coefficients).km ?? 0) - (doseOf(materializeCourse(a, "2000-01-03"), row, coefficients).km ?? 0),
  )[0];
  if (raceCourse == null) throw new Error(`schedule: 第${row.week}周赛周无结构课（比赛课缺失）`);
  dayCourses[raceWd]!.push(raceCourse);
  const activationWd = [raceWd - 2, raceWd - 3].find((wd) => wd >= 0) ?? null;
  const others = structured.filter((c) => c !== raceCourse);
  // 激活课=赛前 2 天优先（#825 激活窗偏 2 天）；多余结构课（罕见）由近及远填空日
  if (activationWd != null && others.length > 0) dayCourses[activationWd]!.push(others.shift()!);
  const earlyDays = Array.from({ length: raceWd }, (_, i) => raceWd - 1 - i).filter((wd) => wd !== activationWd);
  for (const course of others) {
    const wd = earlyDays.find((d) => dayCourses[d]!.length === 0);
    if (wd == null) failures.push(`W${row.week} 赛周结构课 ${course.name} 无空日（daysMax=${daysMax}）——课包超训练日容量`);
    else dayCourses[wd]!.push(course);
  }
  const shakeBudget = Math.max(0, daysMax - 2);
  for (const slot of slots.slice(0, shakeBudget)) {
    const wd = earlyDays.find((d) => dayCourses[d]!.length === 0);
    if (wd == null) repairs.push(`W${row.week} 赛周 E 槽位无空日——剪除`);
    else dayCourses[wd]!.push(slot);
  }
  for (const slot of slots.slice(shakeBudget)) repairs.push(`W${row.week} 赛周 E 槽位剪除（P1 训练日帽）`);
  return { dayCourses, repairs, failures };
}

/** 常规周：周一到周五逐日贪心（谷排 Q/高排 E/到期强制）、周六=LR 前日轻量、周日=LR。 */
function placeNormalWeek(
  bag: WeekBag,
  row: ContentWeekRow,
  ctx: SingleWeekContext,
  coefficients: DoseCoefficients,
  pmc: PmcState,
  repairs: string[],
): Placement {
  const dayCourses: PlannedCourse[][] = Array.from({ length: 7 }, (): PlannedCourse[] => []);
  const regeneration = row.phase === "recovery";
  const lr = bag.courses.find((c): c is StructuredCourse => c.kind === "course" && c.type === "LR") ?? null;
  const qs = bag.courses
    .filter((c): c is StructuredCourse => c.kind === "course" && c.type !== "LR")
    .sort(
      (a, b) => doseOf(materializeCourse(b, "2000-01-03"), row, coefficients).loadPt - doseOf(materializeCourse(a, "2000-01-03"), row, coefficients).loadPt,
    );
  const es = bag.courses.filter((c): c is ESlotCourse => c.kind === "e-slot");
  const daysMax = ctx.athlete.weeklyRunDaysMax;

  // 谷阈值动态化（POC 丢课修复①②）：从 day d 起还能容纳几节 Q（周一-周五、
  // 与已排 Q 间隔 ≥2、彼此间隔 ≥2 的最大装箱）；「今日不排就装不下」→ 到期强制
  const qSlotsFrom = (from: number, lastQ: number): number => {
    const first = Math.max(from, lastQ + 2);
    return first > 4 ? 0 : Math.floor((4 - first) / 2) + 1;
  };
  const deadlineOf = (di: number, lastQ: number, remaining: number) => remaining > qSlotsFrom(di + 1, lastQ);
  // E 日预算（P1 训练日帽前置）：daysMax − LR日 − 质量课日；溢出槽位走双练/剪除（后置处置）
  const eDayBudget = Math.max(0, daysMax - 1 - bag.courses.filter((c) => c.kind === "course" && c.type !== "LR").length);
  let eDaysUsed = 0;
  let lastQ = -10;
  let state = { ...pmc };
  // 周六=LR 前日轻量 E 前置钉入（#825 拍板；allocator 几何对齐——其 eSlots 集恒含
  // 周六，低量周靠它的 [0,8km] 弹性补天花板；interval 倾向槽优先）
  if (lr != null && es.length > 0 && eDayBudget > 0) {
    const idx = es.findIndex((s) => s.band === "interval");
    dayCourses[5]!.push(es.splice(idx >= 0 ? idx : 0, 1)[0]!);
    eDaysUsed++;
  }
  for (let di = 0; di < 5; di++) {
    const ratio = state.chronic > 0 ? state.acute / state.chronic : 1;
    const spacingOk = di - lastQ >= 2;
    // 位型先验：LR 周日时周一=LR 后日不排 Q（2Q+1L 位型 Tue/Thu 落位——
    // Sun LR + Mon Q 背靠背大剂量是日比值冲顶的主形态；到期强制可破例）
    const positionalOk = di !== 0 || lr == null;
    const deadline = qs.length > 0 && deadlineOf(di, lastQ, qs.length);
    // 谷判据=投料后预测比值（pre-dose 比值看不见当日冲击——Q 日剂量大，投前
    // 0.9 投后可 1.3+）：预测超 cap 时顺延让 ATL 消化（到期强制除外，届时交
    // P6 修复/上浮兜底）
    const projected = (dose: number) => {
      const next = advancePmc(state, dose);
      return next.chronic > 0 ? next.acute / next.chronic : 1;
    };
    if (qs.length > 0 && spacingOk && (positionalOk || deadline)) {
      const qLoad = doseOf(materializeCourse(qs[0]!, "2000-01-03"), row, coefficients).loadPt;
      const valleyOk = ratio <= VALLEY_RATIO && projected(qLoad) <= RATIO_CAP;
      if (deadline || valleyOk) {
        const q = qs.shift()!;
        dayCourses[di]!.push(q);
        lastQ = di;
        state = advancePmc(state, qLoad);
        continue;
      }
    }
    if (es.length > 0 && eDaysUsed < eDayBudget) {
      // E 槽位：Q 后一日优先落 interval 槽（间隔日语法），开阔日落 normal 槽；
      // 「高时消化」体现在实例化分钟（比值高→短带下限，water-fill 前的预估同源）
      const afterQ = di - lastQ === 1 && qs.length > 0;
      const idx = es.findIndex((s) => (afterQ ? s.band === "interval" : s.band === "normal"));
      const slot = es.splice(idx >= 0 ? idx : 0, 1)[0]!;
      dayCourses[di]!.push(slot);
      eDaysUsed++;
      // 预估分钟（终值由 water-fill 定；阈值 1.08/1.05=POC 手拍：明显高于均衡带顶
      // 收短带下限、明显低于谷阈值顶满长带，中间取中位）
      const band = eBandOf(slot.band === "interval" || regeneration ? "interval" : "normal", row);
      const minutes = ratio > 1.08 ? band[0] : ratio <= 1.05 ? band[1] : (band[0] + band[1]) / 2;
      state = advancePmc(state, minutes * coefficients.E);
      continue;
    }
    if (qs.length > 0 && spacingOk) {
      // 剩余 Q 强制（无 E 可消化时不再等谷）——强制窗口含周五
      const q = qs.shift()!;
      dayCourses[di]!.push(q);
      lastQ = di;
      state = advancePmc(state, doseOf(materializeCourse(q, "2000-01-03"), row, coefficients).loadPt);
    }
  }
  if (lr != null) dayCourses[6]!.push(lr);

  // 余量处置：P5 双练准入（周量 >110km 附到质量课日）否则剪除
  const surplus = [...qs, ...es];
  if (surplus.length > 0) {
    const doubleOk = row.totalKm > DOUBLE_ADMISSION_KM;
    const qDayOrder = [1, 3, 4, 0, 2].filter((d) => dayCourses[d]!.some((c) => c.kind === "course" && c.type !== "LR"));
    for (const course of surplus) {
      const wd = doubleOk ? (qDayOrder.find((d) => dayCourses[d]!.length === 1) ?? (dayCourses[6]!.length === 1 ? 6 : -1)) : -1;
      if (wd >= 0) {
        dayCourses[wd]!.push(course);
        repairs.push(`W${row.week} ${DAY_LABELS[wd]} 双练日（P5 准入 ${row.totalKm.toFixed(0)}km>${DOUBLE_ADMISSION_KM}）`);
      } else if (course.kind === "course") {
        // 结构课永不剪：LR/Q 是 L3 硬边界（C2/C3），排不下=无解上浮
        return { dayCourses, repairs, failures: [`W${row.week} 结构课 ${course.name} 无合法空日（daysMax=${daysMax}）——课包超训练日容量`] };
      } else {
        repairs.push(`W${row.week} E 槽位无合法空日——剪除`);
      }
    }
  }
  // P1 由 eDayBudget 不变式保证（daysMax−1−q 前置限 E 日）；越界情形 P1 门兜底上浮
  return { dayCourses, repairs, failures: [] };
}

// ── E 实例化与 C1 收敛 ──

/**
 * 落位 flavor（判序=validator C9 同序）：周六=LR 前日 km 帽（再生周亦然——
 * validator 的 lrEve 分支在 regen 分支之前）；赛周激活窗=shake；再生周全短带；
 * 质量课间隔日=短带。
 */
function eFlavorOf(di: number, qualityWds: Set<number>, row: ContentWeekRow, raceWd: number | null): EFlavor {
  if (di === 5) return "lrEve";
  if (raceWd != null && di < raceWd && raceWd - di <= 3) return "shake";
  if (row.phase === "recovery") return "regen";
  const between = [...qualityWds].some((a) => a < di) && [...qualityWds].some((b) => b > di);
  return between ? "interval" : "normal";
}

/**
 * 单周排位主入口（scheduleWeeks 与 R0 scheduleOnly 共用）。
 * 失败不抛：返回 failures（编排层决定重生成 L4a 或上浮）。
 */
export function scheduleWeek(
  bag: WeekBag,
  row: ContentWeekRow,
  ctx: SingleWeekContext,
  pmc: PmcState,
): { schedule: WeekSchedule; pmc: PmcState } | { failures: string[] } {
  const coefficients = ctx.coefficients ?? DEFAULT_DOSE_COEFFICIENTS;
  const weekMonday = mondayOf(ctx.weekMonday);
  const isRaceWeek = row.role === "race";
  const raceDate = isRaceWeek ? (ctx.race?.date ?? null) : null;
  if (isRaceWeek && raceDate == null) return { failures: [`W${row.week} 赛周行缺比赛上下文`] };
  const raceWd = raceDate != null ? weekdayOf(raceDate) : null;
  // 赛周比赛日须落在本周网格（generateWeekContent 入口断言同款；R0 单周重跑防脏输入）
  if (raceWd != null && raceDate != null && dateOf(weekMonday, raceWd) !== raceDate) {
    return { failures: [`W${row.week} 比赛日 ${raceDate} 不在该周网格（周一 ${weekMonday}）`] };
  }
  // 周一/周二比赛：M 激活窗（赛前 2-3 天）跨周不可表达（generateWeekContent 入口
  // 断言同款；scheduleOnly 直调路径同守）——fail fast 不静默产出结构性非法赛周
  if (raceWd != null && raceWd < 2) {
    return { failures: [`W${row.week} 比赛日 ${raceDate} 落在周一/周二——赛前激活窗跨周不可表达`] };
  }

  const repairs: string[] = [];
  const placement =
    raceWd != null ? placeRaceWeek(bag, row, coefficients, raceWd, ctx.athlete.weeklyRunDaysMax) : placeNormalWeek(bag, row, ctx, coefficients, pmc, repairs);
  if (placement.failures.length > 0) return { failures: placement.failures };
  repairs.push(...placement.repairs);
  const dayCourses = placement.dayCourses;

  // 结构课物化（日期落定）；质量周内位集合=判定表口径（含带质量尾段 LR 与比赛课）
  const structuredAt: Array<{ di: number; course: StructuredCourse; workout: RunWorkout }> = [];
  const slotsAt: Array<{ di: number; slot: ESlotCourse }> = [];
  dayCourses.forEach((courses, di) => {
    for (const course of courses) {
      if (course.kind === "course") structuredAt.push({ di, course, workout: materializeCourse(course, dateOf(weekMonday, di)) });
      else slotsAt.push({ di, slot: course });
    }
  });
  const qualityWds = new Set(structuredAt.filter(({ workout }) => hasQualitySegment(workout, row.zones)).map(({ di }) => di));

  // C1 目标（赛周托底 max(骨架, 42.195)，与 validators 同口径）
  const c1Target = isRaceWeek ? Math.max(row.totalKm, 42.195) : row.totalKm;
  const tol = Math.max(3, c1Target * 0.03);

  // E 实例化：位置定带 → 中位起步 → water-fill 双向收敛（只动未顶格槽位）
  const instantiated: Array<{ di: number; slot: ESlotCourse; flavor: EFlavor; minutes: number }> = slotsAt.map(({ di, slot }) => {
    const flavor = eFlavorOf(di, qualityWds, row, raceWd);
    const band = eBandOf(flavor, row);
    return { di, slot, flavor, minutes: (band[0] + band[1]) / 2 };
  });
  const eMid = easyMidOf(row);
  const eKm = () => instantiated.reduce((s, x) => s + (x.minutes * 60) / eMid, 0);
  const structuredKm = structuredAt.reduce((s, { workout }) => s + (doseOf(workout, row, coefficients).km ?? 0), 0);
  let gap = c1Target - structuredKm - eKm();
  // water-fill：带内双向收敛（只动未到边的槽位；per-slot 均摊、上限钳制）
  const fill = () => {
    for (let pass = 0; pass < 6 && Math.abs(gap) > 0.05; pass++) {
      const movable = instantiated.filter((x) => {
        const band = eBandOf(x.flavor, row);
        return gap > 0 ? x.minutes < band[1] - 1e-6 : x.minutes > band[0] + 1e-6;
      });
      if (movable.length === 0) break;
      const perMin = (gap * eMid) / 60 / movable.length;
      for (const x of movable) {
        const band = eBandOf(x.flavor, row);
        x.minutes = Math.max(band[0], Math.min(band[1], x.minutes + perMin));
      }
      gap = c1Target - structuredKm - eKm();
    }
  };
  fill();
  // 仲裁①：超量 → 周六轻量 E 缩短/置休优先回收（轻量帽方向弹性最大）
  if (gap < -tol) {
    const sat = instantiated.find((x) => x.di === 5);
    if (sat != null) {
      const band = eBandOf(sat.flavor, row);
      const cutMin = Math.min(sat.minutes - band[0], ((-gap - tol) * eMid) / 60);
      if (cutMin > 0) {
        sat.minutes -= cutMin;
        gap = c1Target - structuredKm - eKm();
        if (sat.minutes <= band[0] + 1e-6) {
          instantiated.splice(instantiated.indexOf(sat), 1);
          repairs.push(`W${row.week} 周六 E 置休（C1 超界）`);
        } else {
          repairs.push(`W${row.week} 周六 E 缩至 ${Math.round(sat.minutes)}min（C1 收敛）`);
        }
      }
    }
  }
  // 仲裁①'：仍超量=普通带下限垫高（1-Q 周无间隔日、E 全普通带的形态）→
  // 剪下限最高的 E 槽位重灌（槽位经济性修复——课包槽位过多的确定性代价）
  while (gap < -tol && instantiated.length > 0) {
    const droppable = instantiated.filter((x) => x.di !== 5);
    if (droppable.length === 0) break;
    const victim = droppable.reduce((a, b) => (eBandOf(a.flavor, row)[0] >= eBandOf(b.flavor, row)[0] ? a : b));
    instantiated.splice(instantiated.indexOf(victim), 1);
    repairs.push(`W${row.week} ${DAY_LABELS[victim.di]} E 槽位剪除（C1 超界：普通带下限垫高）`);
    gap = c1Target - structuredKm - eKm();
    fill();
  }
  if (Math.abs(gap) > tol) {
    return {
      failures: [
        `W${row.week} 排位无解：C1 周量 ${round2(structuredKm + eKm())} vs 目标 ${c1Target}（±${tol.toFixed(1)}），E 带内不可收敛——课包结构课里程或槽数需调整`,
      ],
    };
  }

  // 物化 + 逐日剂量 → load_series（PMC 逐日推进，休日剂量 0）
  const byDay: Array<RunWorkout[]> = Array.from({ length: 7 }, () => []);
  for (const { di, workout } of structuredAt) byDay[di]!.push(workout);
  for (const { di, slot, flavor, minutes } of instantiated)
    byDay[di]!.push(materializeE(slot, flavor, minutes, dateOf(weekMonday, di), row, ctx.race?.name ?? null));

  const calendar: CalendarDay[] = [];
  let loadSeries: LoadSeriesPoint[] = [];
  let state = { ...pmc };
  const recompute = () => {
    calendar.length = 0;
    loadSeries = [];
    state = { ...pmc };
    for (let di = 0; di < 7; di++) {
      let dose = 0;
      for (const w of byDay[di]!) dose += doseOf(w, row, coefficients).loadPt;
      state = advancePmc(state, dose);
      const ratio = state.chronic > 0 ? round2(state.acute / state.chronic) : null;
      calendar.push({ week: row.week, date: dateOf(weekMonday, di), day: DAY_LABELS[di]!, sessions: byDay[di]! });
      loadSeries.push({
        date: dateOf(weekMonday, di),
        week: row.week,
        loadPt: Math.round(dose * 10) / 10,
        atl: Math.round(state.acute * 10) / 10,
        ctl: Math.round(state.chronic * 10) / 10,
        ratio,
        sessions: byDay[di]!.map((w) => w.name),
      });
    }
  };
  recompute();

  // 仲裁②：P6 越界 → 先挪日后缩 E（票面仲裁手段：挪日/缩 E 时长；≤2 轮；结构课
  // 剂量不可削——仍越界=无解上浮）。比赛日豁免同 P6 门：目标事件非可调度负荷。
  const overCap = (p: LoadSeriesPoint) => p.date !== raceDate && (p.ratio ?? 0) > RATIO_CAP + RATIO_CAP_EPS;
  for (let pass = 0; pass < P6_REPAIR_PASSES * 2 && loadSeries.some(overCap); pass++) {
    const over = loadSeries.find(overCap)!;
    const di = weekdayOf(over.date);
    // ②a 挪日：越界日的质量课挪到更晚的间距合法空平日（让 ATL 多消化一天；
    // 与已排质量日间隔 ≥2、不占周六、目标日在本周末前）
    const qHere = structuredAt.find((x) => x.di === di);
    if (qHere != null) {
      const qWds = structuredAt.map((x) => x.di);
      const lastBefore = qWds.filter((d) => d < di).at(-1) ?? -10;
      const firstAfter = qWds.filter((d) => d > di).at(0) ?? 7;
      const moveTarget =
        Array.from({ length: 4 - di }, (_, k) => di + 1 + k).find((d) => !qWds.includes(d) && d - lastBefore >= 2 && firstAfter - d >= 2) ?? null;
      if (moveTarget != null) {
        qHere.di = moveTarget;
        qHere.workout = materializeCourse(qHere.course, dateOf(weekMonday, moveTarget));
        repairs.push(`W${row.week} ${DAY_LABELS[di]} 质量课挪至 ${DAY_LABELS[moveTarget]}（P6 比值收敛）`);
        byDay.length = 0;
        for (let d = 0; d < 7; d++) byDay.push([]);
        for (const { di: d, workout } of structuredAt) byDay[d]!.push(workout);
        for (const { di: d, slot, flavor, minutes } of instantiated)
          byDay[d]!.push(materializeE(slot, flavor, minutes, dateOf(weekMonday, d), row, ctx.race?.name ?? null));
        recompute();
        continue;
      }
    }
    const eIdx = instantiated.findLastIndex((x) => x.di === di);
    if (eIdx < 0) break;
    const x = instantiated[eIdx]!;
    const band = eBandOf(x.flavor, row);
    if (x.minutes <= band[0] + 1e-6) {
      instantiated.splice(eIdx, 1);
      byDay[di] = byDay[di]!.filter((w) => w.type !== "E");
      repairs.push(`W${row.week} ${DAY_LABELS[di]} E 置休（P6 比值越界且已达带下限）`);
    } else {
      x.minutes = band[0];
      byDay[di] = [
        ...byDay[di]!.filter((w) => w.type !== "E"),
        ...instantiated.filter((y) => y.di === di).map((y) => materializeE(y.slot, y.flavor, y.minutes, dateOf(weekMonday, di), row, ctx.race?.name ?? null)),
      ];
      repairs.push(`W${row.week} ${DAY_LABELS[di]} E 缩至 ${Math.round(band[0])}min（P6 比值收敛）`);
    }
    recompute();
  }
  if (loadSeries.some(overCap)) {
    const worst = loadSeries.filter((p) => p.date !== raceDate).reduce((a, b) => ((b.ratio ?? 0) > (a.ratio ?? 0) ? b : a));
    return { failures: [`W${row.week} 排位无解：P6 日负荷比 ${worst.ratio} 超 cap ${RATIO_CAP}（${worst.date}）——课包刺激密度超出波浪容量`] };
  }
  // P6 修复（缩 E/置休）可能打破 C1 守恒——复检归位到结构冲突定性（周量 vs 波形
  // 容量不可兼得），不让它漏到终检被误读为课包缺陷
  const postGap = c1Target - structuredKm - instantiated.reduce((sum, x) => sum + (x.minutes * 60) / eMid, 0);
  if (Math.abs(postGap) > tol) {
    return {
      failures: [
        `W${row.week} 排位无解：P6×C1 结构冲突（比值收敛后周量 ${round2(c1Target - postGap)} vs 目标 ${c1Target}，±${tol.toFixed(1)}）——种子×周量超出波浪容量`,
      ],
    };
  }

  const sessions = byDay.flat();
  const checks = scheduleGates({ calendar, loadSeries, row, daysMax: ctx.athlete.weeklyRunDaysMax, raceDate, coefficients });
  if (checks.some((c) => !c.pass)) {
    return { failures: checks.filter((c) => !c.pass).map((c) => `W${row.week} ${c.id}：${c.detail}`) };
  }
  return { schedule: { week: row.week, sessions, calendar, loadSeries, checks, repairs }, pmc: state };
}

// ── 整段入口 ──

export function scheduleWeeks(bags: WeekBag[], ctx: ScheduleContext): ScheduleResult {
  const coefficients = ctx.coefficients ?? DEFAULT_DOSE_COEFFICIENTS;
  const rowOfWeek = new Map(ctx.rows.map((r) => [r.week, r]));
  const weeks: WeekSchedule[] = [];
  const failures: string[] = [];
  let pmc: PmcState = { ...ctx.pmcSeed };
  for (const bag of bags) {
    const row = rowOfWeek.get(bag.week);
    if (row == null) {
      failures.push(`W${bag.week} 不在骨架行内`);
      continue;
    }
    const monday = mondayOf(dateOf(ctx.planStartMonday, (row.week - 1) * 7));
    const result = scheduleWeek(bag, row, { weekMonday: monday, race: ctx.race, athlete: ctx.athlete, coefficients }, pmc);
    if ("failures" in result) {
      failures.push(...result.failures);
      continue;
    }
    pmc = result.pmc;
    weeks.push(result.schedule);
  }
  const coefficientVersion = coefficients === DEFAULT_DOSE_COEFFICIENTS ? COEFFICIENT_VERSION : "custom";
  const loadMeta: LoadMeta = {
    model: "exp-pmc-7-42",
    seed: { acute: ctx.pmcSeed.acute, chronic: ctx.pmcSeed.chronic, source: "生成时点直读生产 PMC 当日快照（daily_training_load.acute_load/chronic_load）" },
    coefficient_version: coefficientVersion,
  };
  return { weeks, loadMeta, ok: weeks.length === bags.length && failures.length === 0, failures };
}

/**
 * R0 夜复盘微调入口（ticket #4：换日/单课减量只重跑本段不碰 LLM）。
 * 输入改后的课包 + 当日 PMC 快照 → 该周日历/load_series；无解返回 failures。
 */
export function scheduleOnly(bag: WeekBag, row: ContentWeekRow, ctx: SingleWeekContext, pmcSnapshot: PmcState): WeekSchedule | { failures: string[] } {
  const result = scheduleWeek(bag, row, ctx, pmcSnapshot);
  return "schedule" in result ? result.schedule : { failures: result.failures };
}
