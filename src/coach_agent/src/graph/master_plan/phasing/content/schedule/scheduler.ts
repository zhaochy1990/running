import { normalizeRunWorkout, type RunWorkout } from "@stride/contract";
import { allocateRaceWeek } from "../allocate.js";
import { hasQualitySegment } from "../derive.js";
import type { ContentRaceContext, ContentWeekRow } from "../doctrine.js";
import { type ContentValidation, E_DURATION_INTERVAL_BAND, E_DURATION_NORMAL_BAND, LR_EVE_MAX_KM, sessionKm, weekdayOf } from "../validators.js";
import { type AvailabilityConstraints, doubleSessionAllowed, effectiveDaysMaxOf, isAvailableDay, windowLimitOf } from "./availability.js";
import {
  boundaryPrefix,
  compareCandidates,
  contextMetrics,
  type DayFact,
  type DistributionMetrics,
  distributionMetrics,
  dominates,
  enumeratePlacements,
  factsOfWeek,
  formatDistributionMetrics,
  noWorseBatch,
  placementLabel,
  runDaysOf,
  sameFacts,
  scheduleLabel,
} from "./distribution.js";
import { COEFFICIENT_VERSION, courseDose, DEFAULT_DOSE_COEFFICIENTS, type DoseCoefficients, elapsedMinutes } from "./dose.js";
import { DOUBLE_ADMISSION_KM, RATIO_CAP, RATIO_CAP_EPS, type ScheduleCheck, scheduleGates } from "./gates.js";

/**
 * L4b 波浪调度器（devops#799，contract.md §6 / daniels-l4-content.md §6）：
 * L4a 课包（无 day、E=槽位+时长带）+ L3 周行（km/lr/q 硬边界）+ 生产 PMC 当日
 * 快照种子 → 周内逐日贪心排位（谷排刺激/高时消化/LR 周日位型先验/周六 LR 前日
 * 轻量）→ E 槽位实例化（位置定带、water-fill 收敛 C1）→ 日历 + load_series
 * （exp-pmc-7-42 与生产同款常数）。
 *
 * 日期分布优化（devops#1043）：贪心落位只是基准。scheduleWeeks 对每个常规周
 * 枚举「同课数、同跑步日数」的替代落位，逐个走同一条实例化+门禁路径，只用
 * 过门的候选比三项分布指标（最长连跑/最长连休/含关键课三日负荷峰），淘汰被
 * 超过的扎堆安排；跨周接已知边界日历（实绩/生效安排）。交界复核=前向多遍
 * （后一遍带前一遍的下一周），整批分布指标不变差才采纳、到不动点为止。后续周
 * 因负荷排不出时优先调整可变周（devops#1054：回到最近的常规周改选下一个候选、
 * 重排其后各周），回溯预算用尽仍无解而贪心日历可行时才回退贪心。排课同时受
 * 用户可用度硬约束：可跑日、日内时窗（P9，按含休息的墙钟时长）、双练许可——与
 * 课包/位型冲突时带具体冲突上浮（ScheduleResult.conflicts）。
 * 固定课包守恒（devops#1054）：排不下的课不静默剪除，最终课表逐项对账
 * （bagDeviationOf）。
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
  /** P1-P9（gates.ts）。 */
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
  /** 常规周的日期分布选择留痕（devops#1043；赛周不枚举候选，无留痕）。 */
  distribution: WeekDistributionAudit[];
  /**
   * failures 中属于用户可用度与课包/位型硬冲突的部分（devops#1043「返回受冲突的
   * 日期和约束」；空=无）：长跑周日不可跑、可跑日装不下课包、课包装不进训练日容量
   * （又不能靠一天两练）、结构课超出可训练时段（日内时窗）、普通
   * 轻松课下限容不下、赛周激活窗无可跑日或激活课超时窗。编排层据此归类结构性无解。
   */
  conflicts: string[];
}

/** 周内位的中文星期（可跑日/冲突说明用）。 */
const WEEKDAY_CN = "一二三四五六日";
const weekdaysLabel = (weekdays: readonly number[]): string => weekdays.map((weekday) => WEEKDAY_CN[weekday]).join("/");
/** 可跑日说明后缀：「，可跑日=二/四/六/日」；未知=空串；一个都没有=「，无可跑日」。 */
const availableNote = (available: readonly number[] | null): string =>
  available == null ? "" : available.length === 0 ? "，无可跑日" : `，可跑日=${weekdaysLabel(available)}`;

/** 一个落位候选在日期分布比较里的留痕（devops#1043）。 */
export interface DistributionCandidateAudit {
  /** 周一→周日的落位，如「休·T·休·E·休·E·LR」。 */
  label: string;
  /** 跑步日周内位。 */
  runDays: number[];
  /** 过全部硬约束（实例化 + P 门 + C 门）。 */
  feasible: boolean;
  /** 不过门的原因（受冲突的约束）。 */
  failures: string[];
  /** 选择时点（所依据的前后周）的三项分布指标；不参与比较的候选=null。 */
  metrics: DistributionMetrics | null;
  /** 支配本候选（三项均不差且至少一项更好）的候选下标；没有=null。 */
  dominatedBy: number | null;
}

/** 单周日期分布选择留痕：候选指标、被淘汰关系与选择原因（审计读它解释最终日历）。 */
export interface WeekDistributionAudit {
  week: number;
  /** 选定候选在 candidates 中的下标（candidates[0] 恒为贪心基准）。 */
  chosen: number;
  /** 选择时的已知边界：本周周一之前 7 天、之后下一周（未知=null）。 */
  prefix: DayFact[];
  suffix: DayFact[] | null;
  /** 选择原因（人读）。 */
  reason: string;
  /** 约束现状：集中若仍在，由什么造成（可跑日/跑步日上限/长跑位型）。 */
  constraints: string[];
  /**
   * 选定候选在最终前后周下的指标——审计文字用它（候选的 metrics 是选择时上下文
   * 的，复核未收敛时两者不同）。
   */
  finalMetrics: DistributionMetrics;
  /**
   * 交界复核是否收敛：true=选择时依据的下一周就是最终日历；false=再改排会让整批
   * 变差，复核停在了不动点之前。
   */
  converged: boolean;
  candidates: DistributionCandidateAudit[];
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
  /** 用户可用度（devops#1043 可跑日、双练许可；devops#1054 日内时窗）；缺省=未声明。 */
  availability?: AvailabilityConstraints;
  /**
   * 首周周一之前的已知相邻日历（devops#1043：实绩或生效安排；任意长度，缺的
   * 日期=未知）。首周接已知历史/上一批末周；批内后续周接前一周的排位产物。
   */
  boundary?: DayFact[];
  /**
   * 排位后课程校验器（generate.ts 提供）：日期分布候选逐个复算按落位判定的 C 门
   * （如 E 时长分层 C9）；缺省=只判 P 门。
   */
  validateWeek?: WeekValidator;
  /**
   * 回溯改选的次数上限（devops#1054「优先调整可变周」）：后续周排不出时回到可变周
   * 改选下一个候选，超过上限交回贪心回退。缺省 120；留给测试把预算压到 0 复现
   * 「预算用尽 → 贪心兜底」，不是给调用方调的配置。
   */
  backtrackLimit?: number;
}

/** 排位后课程校验器（C 门）：日期分布候选逐个复算（devops#1043）。 */
export type WeekValidator = (sessions: RunWorkout[], row: ContentWeekRow) => ContentValidation[];

/** scheduleOnly（R0 夜复盘微调）单周上下文。 */
export interface SingleWeekContext {
  /** 该周周一 ISO date（日历映射锚）。 */
  weekMonday: string;
  race: ContentRaceContext | null;
  athlete: { weeklyRunDaysMax: number };
  coefficients?: DoseCoefficients;
  /** 用户可用度（devops#1043）；缺省=未声明。 */
  availability?: AvailabilityConstraints;
  /** 上周日（已知边界日）含质量课——P2 跨周判定（devops#1043）。 */
  previousDayQuality?: boolean;
  /** 排位后课程校验器（同 ScheduleContext；候选比较用）。 */
  validateWeek?: WeekValidator;
}

/** 贪心谷阈值（比值 ≤θ 排下一刺激/≥θ 只消化——POC 手拍值，行为对照通过）。 */
const VALLEY_RATIO = 1.02;
/** P6 修复轮上限（挪日与缩 E 各计一轮）。 */
const P6_REPAIR_PASSES = 2;
/** E 分钟取整粒度（30s）。 */
const E_MINUTE_ROUND_S = 30;
/** strides 触感块（E 槽位 strides=true 时物化）：4×100m。 */
const STRIDES_COUNT = 4;
const STRIDE_M = 100;

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

/** LR 前日 E 最低有效时长（分钟，2026-11-01 拍板）：单独 E 课 <30min 生理刺激
 * 边际趋零。处置=整课置休并把这份量摊回周内其他 E 槽（间隔日/周一带内上涨），
 * 而不是拉长到 30min 保课——用户拍板「量平均分配到周内其他课」；water-fill
 * 能分到 ≥30min 时保留（30-60min shakeout 是合法形态）。 */
const LR_EVE_MIN_MINUTES = 30;

/** 落位时长带（分钟）：间隔日/再生周=短带；LR 前日=km 帽（下限 0，有效性由
 * 置休摊量仲裁保证）；赛周激活窗=短帽。limitMin=该日 E 课可用的分钟上限
 * （devops#1054：当日时窗，双练日再扣掉同日结构课）：上下限
 * 都只往下钳、不超过它（上限不够时整带并到上限，再由 C9/P9 判合法性）。 */
function eBandOf(flavor: EFlavor, row: ContentWeekRow, limitMin: number | null = null): [number, number] {
  const eMid = easyMidOf(row);
  const band: [number, number] = (() => {
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
  })();
  return limitMin == null ? band : [Math.min(band[0], limitMin), Math.min(band[1], limitMin)];
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
  const stridesM = slot.strides ? STRIDES_COUNT * STRIDE_M : 0;
  let seconds = Math.max(E_MINUTE_ROUND_S, Math.round((minutes * 60) / E_MINUTE_ROUND_S) * E_MINUTE_ROUND_S);
  // LR 前日轻量帽按课整程 km 终钳（30s 取整可越帽；strides 里程计入帽——#825 帽
  // 判定=P3 按课实际里程（含 strides），钳制不扣它就会自产 8.4km>8 假违规）
  if (flavor === "lrEve") seconds = Math.min(seconds, Math.floor(((LR_EVE_MAX_KM - stridesM / 1000) * eMid) / E_MINUTE_ROUND_S) * E_MINUTE_ROUND_S);
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
              repeat: STRIDES_COUNT,
              steps: [
                {
                  step_kind: "work" as const,
                  duration: { kind: "distance_m" as const, value: STRIDE_M },
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
  /**
   * failures 中属于用户可用度与课包/位型硬冲突的部分（devops#1043；编排层据此
   * 归类为结构性无解并带具体冲突）。
   */
  conflicts: string[];
}

/** 长跑位型与可跑日的硬冲突：周日不可跑而长跑须排周日（devops#1043 拍板=硬约束无解）；无冲突=null。 */
function longRunDayConflictOf(row: ContentWeekRow, available: readonly number[] | null): string | null {
  if (available == null || available.includes(6)) return null;
  const label = available.length === 0 ? "无" : weekdaysLabel(available);
  return `W${row.week} 周日为不可跑日——长跑须排周日（P3 位型），与可跑日（${label}）冲突`;
}

/** 赛周课包里的比赛课=里程最大的结构课（placeRaceWeek 与冲突归因同判据）；没有结构课=null。 */
function raceCourseOf(structured: readonly StructuredCourse[], row: ContentWeekRow, coefficients: DoseCoefficients): StructuredCourse | null {
  return (
    [...structured].sort(
      (a, b) =>
        (doseOf(materializeCourse(b, "2000-01-03"), row, coefficients).km ?? 0) - (doseOf(materializeCourse(a, "2000-01-03"), row, coefficients).km ?? 0),
    )[0] ?? null
  );
}

/** 比赛周：比赛课（最大里程结构课）钉比赛日（P4）、其余结构课=M 激活（赛前 2-3 天）、E 槽填赛前窗。 */
function placeRaceWeek(bag: WeekBag, row: ContentWeekRow, ctx: SingleWeekContext, coefficients: DoseCoefficients, raceWd: number, daysMax: number): Placement {
  const dayCourses: PlannedCourse[][] = Array.from({ length: 7 }, (): PlannedCourse[] => []);
  const repairs: string[] = [];
  const failures: string[] = [];
  const conflicts: string[] = [];
  // 可跑日（devops#1043）：激活课与赛前 E 只落可跑日；比赛日是固定事件不受此约束
  const available = ctx.availability?.availableWeekdays ?? null;
  const isAvailable = (wd: number) => isAvailableDay(available, wd);
  const structured = bag.courses.filter((c): c is StructuredCourse => c.kind === "course");
  const slots = bag.courses.filter((c): c is ESlotCourse => c.kind === "e-slot");
  const raceCourse = raceCourseOf(structured, row, coefficients);
  if (raceCourse == null) throw new Error(`schedule: 第${row.week}周赛周无结构课（比赛课缺失）`);
  dayCourses[raceWd]!.push(raceCourse);
  // 激活课=原书周二位优先（2026-11-01 校准，raceWd-5 起最早空日；#825 偏 2 天口径由原书取代）
  const activationWindow = [raceWd - 5, raceWd - 4, raceWd - 3, raceWd - 2].filter((wd) => wd >= 0);
  const activationWd = activationWindow.find((wd) => isAvailable(wd)) ?? null;
  const others = structured.filter((c) => c !== raceCourse);
  if (activationWd == null && others.length > 0) {
    // 激活窗内没有可跑日（devops#1043）：激活课不能挪到通勤日/赛前隔日——用户
    // 可用度与既有赛周位型的硬冲突，带具体冲突上浮（无可跑日声明时走不到这里：
    // 周一/周二比赛已在 scheduleWeek 入口拒绝）
    const conflict = `W${row.week} 赛前激活窗（${weekdaysLabel(activationWindow)}）没有可跑日${availableNote(available)}——赛前激活课 ${others[0]!.name} 无处可排`;
    return { dayCourses, repairs, failures: [conflict], conflicts: [conflict] };
  }
  if (activationWd != null && others.length > 0) dayCourses[activationWd]!.push(others.shift()!);
  const earlyDays = Array.from({ length: raceWd }, (_, i) => raceWd - 1 - i).filter((wd) => wd !== activationWd && isAvailable(wd));
  for (const course of others) {
    const wd = earlyDays.find((d) => dayCourses[d]!.length === 0);
    if (wd == null) failures.push(`W${row.week} 赛周结构课 ${course.name} 无空日（daysMax=${daysMax}${availableNote(available)}）——课包超训练日容量`);
    else dayCourses[wd]!.push(course);
  }
  // 通勤感知落位（2026-11-01 拍板，与 allocateRaceWeek 同源）：默认周六通勤=周六休、
  // 周五 shakeout；周五通勤（travelDay=friday）=周五休、周六 shakeout。E 槽优先落
  // allocate 的确定性 weekday（通勤日前一天=shakeout 主课、周四=赛前 3 天短 E），
  // 多余槽（LLM 多给）按早空日、通勤日必空。
  const raceCtxLike = { ...ctx.race, travelDay: ctx.race?.travelDay ?? ("saturday" as const) };
  const allocShakes = allocateRaceWeek(row, raceCtxLike as never).shakes;
  const travelWd = raceCtxLike.travelDay === "friday" ? 4 : 5;
  const shakeBudget = Math.max(0, daysMax - (ctx.race?.distance === "HM" ? structured.length : 2));
  const placed: number[] = [];
  for (const slot of slots.slice(0, shakeBudget)) {
    const hint = allocShakes.find((x) => !placed.includes(x.weekday) && isAvailable(x.weekday))?.weekday;
    const wd = hint ?? earlyDays.find((d) => d !== travelWd && dayCourses[d]!.length === 0);
    if (wd == null || (ctx.race?.distance !== "HM" && wd === travelWd)) repairs.push(`W${row.week} 赛周 E 槽位无空日——剪除`);
    else {
      dayCourses[wd]!.push(slot);
      placed.push(wd);
    }
  }
  for (const slot of slots.slice(shakeBudget)) repairs.push(`W${row.week} 赛周 E 槽位剪除（P1 训练日帽）`);
  return { dayCourses, repairs, failures, conflicts };
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
  // 可跑日（devops#1043）：具体日期未知（存量只有天数上限）时七天皆可；天数上限
  // 同时受可跑日数封顶。长跑位型固定周日——周日不可跑=硬约束无解，交回上游。
  const available = ctx.availability?.availableWeekdays ?? null;
  const isAvailable = (di: number) => isAvailableDay(available, di);
  const daysMax = effectiveDaysMaxOf(ctx.athlete.weeklyRunDaysMax, ctx.availability);
  const longRunConflict = longRunDayConflictOf(row, available);
  if (lr != null && longRunConflict != null) return { dayCourses, repairs, failures: [longRunConflict], conflicts: [longRunConflict] };

  // 谷阈值动态化（POC 丢课修复①②）：从 day d 起还能容纳几节 Q（可跑平日、
  // 与已排 Q 间隔 ≥2、彼此间隔 ≥2 的最大装箱）；「今日不排就装不下」→ 到期强制
  const weekdays = [0, 1, 2, 3, 4].filter(isAvailable);
  const qSlotsFrom = (from: number, lastQ: number): number => {
    let next = Math.max(from, lastQ + 2);
    let slots = 0;
    for (const weekday of weekdays) {
      if (weekday < next) continue;
      slots++;
      next = weekday + 2;
    }
    return slots;
  };
  const deadlineOf = (di: number, lastQ: number, remaining: number) => remaining > qSlotsFrom(di + 1, lastQ);
  // E 日预算（P1 训练日帽前置）：daysMax − LR日 − 质量课日；溢出槽位走双练/剪除（后置处置）
  const eDayBudget = Math.max(0, daysMax - 1 - bag.courses.filter((c) => c.kind === "course" && c.type !== "LR").length);
  let eDaysUsed = 0;
  let lastQ = -10;
  let state = { ...pmc };
  // 周六=LR 前日轻量 E 前置钉入（#825 拍板；allocator 几何对齐——其 eSlots 集恒含
  // 周六，低量周靠它的 [0,8km] 弹性补天花板；interval 倾向槽优先）
  if (lr != null && es.length > 0 && eDayBudget > 0 && isAvailable(5)) {
    const idx = es.findIndex((s) => s.band === "interval");
    dayCourses[5]!.push(es.splice(idx >= 0 ? idx : 0, 1)[0]!);
    eDaysUsed++;
  }
  for (const di of weekdays) {
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

  // 余量处置：P5 双练准入（周量 >110km 且用户许可，附到质量课日）；准入不了的余量课
  // 没有合法空日——固定课包不静默剪除（devops#1054：此前剪掉 E 槽位后量能收敛就
  // 少交一节课），带具体冲突上浮
  const surplus = [...qs, ...es];
  if (surplus.length > 0) {
    const doubleOk = doubleSessionAllowed(row.totalKm, DOUBLE_ADMISSION_KM, ctx.availability);
    const qDayOrder = [1, 3, 4, 0, 2].filter((d) => isAvailable(d) && dayCourses[d]!.some((c) => c.kind === "course" && c.type !== "LR"));
    for (const course of surplus) {
      const wd = doubleOk ? (qDayOrder.find((d) => dayCourses[d]!.length === 1) ?? (isAvailable(6) && dayCourses[6]!.length === 1 ? 6 : -1)) : -1;
      if (wd >= 0) {
        dayCourses[wd]!.push(course);
        repairs.push(`W${row.week} ${DAY_LABELS[wd]} 双练日（P5 准入 ${row.totalKm.toFixed(0)}km>${DOUBLE_ADMISSION_KM}）`);
        continue;
      }
      // 课包装不进可跑日（节数超训练日容量且不能一天两练）=用户可用度与课包的硬冲突；
      // 结构课永不剪：LR/Q 是 L3 硬边界（C2/C3），排不下=无解上浮
      const conflict = bagCapacityConflictOf(bag.courses.length, row, ctx, daysMax);
      return {
        dayCourses,
        repairs,
        failures: [
          conflict ??
            `W${row.week} ${course.kind === "course" ? `结构课 ${course.name}` : "E 槽位"} 无合法空日（daysMax=${daysMax}${availableNote(available)}）——课包超训练日容量`,
        ],
        conflicts: conflict == null ? [] : [conflict],
      };
    }
  }
  // P1 由 eDayBudget 不变式保证（daysMax−1−q 前置限 E 日）；越界情形 P1 门兜底上浮
  return { dayCourses, repairs, failures: [], conflicts: [] };
}

/**
 * 课包装不进训练日容量（devops#1054「固定四课且仅能三天、禁止双练」）：节数超过
 * 每周跑步日上限、又不能靠一天两练装下（周量 >110km 且用户许可才准入）——归到
 * 真正的约束上，而不是被它连带出来的周量/时长带违规。装得下=null。
 */
function bagCapacityConflictOf(count: number, row: ContentWeekRow, ctx: SingleWeekContext, daysMax: number): string | null {
  const availability = ctx.availability;
  const available = availability?.availableWeekdays ?? null;
  if (count <= daysMax || doubleSessionAllowed(row.totalKm, DOUBLE_ADMISSION_KM, availability)) return null;
  if (available != null && count > available.length)
    return `W${row.week} 可跑日不足：${available.length === 0 ? "没有可跑日" : `可跑日 ${available.length} 天（${weekdaysLabel(available)}）`}装不下课包 ${count} 节（${
      availability?.allowsDoubleSessions === false ? "一天两练未获许可" : "一天两练未达准入（周量 ≤110km）"
    }）`;
  return `W${row.week} 双练未获许可：课包 ${count} 节超过每周跑步日上限 ${daysMax}——周量 ${row.totalKm.toFixed(0)}km 的课包需一天两练才装得下（${
    availability?.allowsDoubleSessions === false ? "allows_double_sessions=false" : `周量 ≤${DOUBLE_ADMISSION_KM}km，一天两练未达准入`
  }）`;
}

// ── E 实例化与 C1 收敛 ──

/**
 * 落位 flavor（判序=validator C9 同序）：赛周激活窗=shake 优先于周六——赛周无 LR，
 * 比赛前的周六 E 是赛前激活不是「LR 前日」（#824 抽查发现：否则 purpose 会生成
 * 「为明日长跑蓄力」而明日是比赛）；周六=LR 前日 km 帽（再生周亦然——validator
 * 的 lrEve 分支在 regen 分支之前）；再生周全短带；质量课间隔日=短带。
 */
function eFlavorOf(di: number, qualityWds: Set<number>, row: ContentWeekRow, raceWd: number | null): EFlavor {
  if (raceWd != null && di < raceWd && raceWd - di <= 3) return "shake";
  if (di === 5) return "lrEve";
  if (row.phase === "recovery") return "regen";
  // taper 周 E 全短带（2026-11-01 原书校准）：减量从单课体积出——E 多而短、保持频率
  if (row.role === "taper") return "interval";
  const between = [...qualityWds].some((a) => a < di) && [...qualityWds].some((b) => b > di);
  return between ? "interval" : "normal";
}

/**
 * 单周排位主入口（scheduleWeeks 的赛周与 R0 scheduleOnly 共用；常规周在
 * scheduleWeeks 里走 scheduleDistributedWeek 的候选比较，本函数=其贪心基准）。
 * 失败不抛：返回 failures（编排层决定重生成 L4a 或上浮）。
 */
export function scheduleWeek(
  bag: WeekBag,
  row: ContentWeekRow,
  ctx: SingleWeekContext,
  pmc: PmcState,
): { schedule: WeekSchedule; pmc: PmcState } | { failures: string[]; conflicts?: string[] } {
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
  if (raceWd != null && raceWd < 2 && ctx.race?.distance !== "HM") {
    return { failures: [`W${row.week} 比赛日 ${raceDate} 落在周一/周二——赛前激活窗跨周不可表达`] };
  }

  // 排位（贪心）→ 实例化+门禁；排位阶段的结构性失败（课包超训练日容量等）直接上浮
  const repairs: string[] = [];
  const placement =
    raceWd != null
      ? placeRaceWeek(bag, row, ctx, coefficients, raceWd, ctx.athlete.weeklyRunDaysMax)
      : placeNormalWeek(bag, row, ctx, coefficients, pmc, repairs);
  if (placement.failures.length > 0) return { failures: placement.failures, conflicts: placement.conflicts };
  repairs.push(...placement.repairs);
  return instantiateWeek({ dayCourses: placement.dayCourses, row, ctx, weekMonday, raceWd, raceDate, pmc, repairs, bagCourses: bag.courses });
}

/**
 * 落位 → 实例化 + 门禁（scheduleWeek 的贪心落位与日期分布候选共用同一条路径，
 * devops#1043——所有候选都按落位重算既有负荷与课程校验）：结构课物化、E 槽位
 * 按位置定带并 water-fill 收敛 C1、层内仲裁、P 门。失败不抛：返回 failures。
 */
export function instantiateWeek(input: {
  dayCourses: PlannedCourse[][];
  row: ContentWeekRow;
  ctx: SingleWeekContext;
  weekMonday: string;
  raceWd: number | null;
  raceDate: string | null;
  pmc: PmcState;
  /** 修复留痕累加器（排位阶段的留痕已在内，本函数继续追加）。 */
  repairs: string[];
  /** 固定课包的全部课（devops#1054 课包守恒终检：最终物化课表逐项对账，必传）。 */
  bagCourses: PlannedCourse[];
}): { schedule: WeekSchedule; pmc: PmcState } | { failures: string[] } {
  const { dayCourses, row, ctx, weekMonday, raceWd, raceDate, pmc, repairs } = input;
  const coefficients = ctx.coefficients ?? DEFAULT_DOSE_COEFFICIENTS;
  const isRaceWeek = raceWd != null;
  const available = ctx.availability?.availableWeekdays ?? null;
  const isAvailable = (di: number) => isAvailableDay(available, di);
  const eMid = easyMidOf(row);
  // E 课可用的分钟上限（devops#1054）：声明了时窗时受「当日最长一段时窗 − 同日结构课
  // 的墙钟时长」限制——双练日的轻松课只占用结构课剩下的时段；没声明=不受限。结构课
  // 时长由课包决定、本段不裁剪——超限由 P9 门拦下，无解原因由 availabilityConflictOf 归位
  const eLimitOf = (di: number): number | null => {
    const window = ctx.availability?.windowMinutes?.[di];
    if (window == null) return null;
    const taken = structuredAt.filter((x) => x.di === di).reduce((sum, x) => sum + (elapsedMinutes(x.workout, eMid) ?? 0), 0);
    return Math.max(0, window - taken);
  };
  const bandOf = (flavor: EFlavor, di: number): [number, number] => eBandOf(flavor, row, eLimitOf(di));

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
  const c1Target = isRaceWeek ? Math.max(row.totalKm, ctx.race?.distance === "HM" ? 21.0975 : 42.195) : row.totalKm;
  const tol = Math.max(3, c1Target * 0.03);

  // E 实例化：位置定带 → 中位起步 → water-fill 双向收敛（只动未顶格槽位）
  const instantiated: Array<{ di: number; slot: ESlotCourse; flavor: EFlavor; minutes: number }> = slotsAt.map(({ di, slot }) => {
    const flavor = eFlavorOf(di, qualityWds, row, raceWd);
    const band = bandOf(flavor, di);
    return { di, slot, flavor, minutes: (band[0] + band[1]) / 2 };
  });
  const eKm = () => instantiated.reduce((s, x) => s + (x.minutes * 60) / eMid, 0);
  const structuredKm = structuredAt.reduce((s, { workout }) => s + (doseOf(workout, row, coefficients).km ?? 0), 0);
  let gap = c1Target - structuredKm - eKm();
  // water-fill：带内双向收敛（只动未到边的槽位；per-slot 均摊、上限钳制）
  const fill = () => {
    for (let pass = 0; pass < 6 && Math.abs(gap) > 0.05; pass++) {
      const movable = instantiated.filter((x) => {
        const band = bandOf(x.flavor, x.di);
        return gap > 0 ? x.minutes < band[1] - 1e-6 : x.minutes > band[0] + 1e-6;
      });
      if (movable.length === 0) break;
      const perMin = (gap * eMid) / 60 / movable.length;
      for (const x of movable) {
        const band = bandOf(x.flavor, x.di);
        x.minutes = Math.max(band[0], Math.min(band[1], x.minutes + perMin));
      }
      gap = c1Target - structuredKm - eKm();
    }
  };
  fill();
  // 仲裁⓪：LR 前日 E 低于最低有效时长 → 整课置休、量摊回周内其他 E 槽（fill
  // 重灌）——周六 14-20min 的独立短课刺激趋零，摊给间隔日/周一比保课更有意义
  // （2026-11-01 拍板）。可回滚：其他槽顶格吸收不了（低量周周六帽天然小）时恢复
  // 原课——短课无益但 C1 守恒优先，结构性缺量的正确出口是排位无解上浮而非静默丢量。
  if (raceWd == null) {
    const satIdx = instantiated.findIndex((x) => x.di === 5);
    if (satIdx >= 0 && instantiated[satIdx]!.minutes < LR_EVE_MIN_MINUTES) {
      const sat = instantiated[satIdx]!;
      const satMinutes = sat.minutes;
      instantiated.splice(satIdx, 1);
      gap = c1Target - structuredKm - eKm();
      fill();
      if (Math.abs(gap) > tol) {
        instantiated.push(sat);
        sat.minutes = satMinutes;
        gap = c1Target - structuredKm - eKm();
        fill();
      } else {
        repairs.push(`W${row.week} 周六 E ${Math.round(satMinutes)}min<${LR_EVE_MIN_MINUTES}min 无效剂量——置休，量摊至周内其他课`);
      }
    }
  }
  // 仲裁①：超量 → 周六轻量 E 缩短/置休优先回收（轻量帽方向弹性最大）
  if (gap < -tol) {
    const sat = instantiated.find((x) => x.di === 5);
    if (sat != null) {
      const band = bandOf(sat.flavor, sat.di);
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
    const victim = droppable.reduce((a, b) => (bandOf(a.flavor, a.di)[0] >= bandOf(b.flavor, b.di)[0] ? a : b));
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
  // 通勤消耗与调整说明（2026-11-01 拍板）：默认周六通勤=周六休、周五（通勤前一天）
  // shakeout 保持状态；notes 写明周五通勤的调整法（周五完全不跑、本课挪周六）。
  const travelWdE = ctx.race != null ? (ctx.race.travelDay === "friday" ? 4 : 5) : null;
  const instantiateWithNotes = (inst: Array<{ di: number; slot: ESlotCourse; flavor: EFlavor; minutes: number }>) => {
    for (const { di, slot, flavor, minutes } of inst) {
      const workout = materializeE(slot, flavor, minutes, dateOf(weekMonday, di), row, ctx.race?.name ?? null);
      if (isRaceWeek && travelWdE != null && flavor === "shake" && di === (travelWdE === 5 ? 4 : 5)) {
        const dayCn = (wd: number) => "一二三四五六"[wd];
        workout.note =
          `默认按周${dayCn(travelWdE)}通勤设计：周${dayCn(travelWdE)}不安排跑步——赶路+领物+早点休息，注意补水与晚餐碳水（通勤本身是消耗）。` +
          `本课在通勤前一天保持状态；若实际周${dayCn(travelWdE === 5 ? 4 : 5)}通勤，则当天完全不跑，把本课挪到周${dayCn(travelWdE)}执行。`;
      }
      byDay[di]!.push(workout);
    }
  };
  instantiateWithNotes(instantiated);

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
    // ②a 挪日：越界日的质量课挪到更晚的间距合法平日（让 ATL 多消化一天；与已排
    // 质量日间隔 ≥2、不占周六、目标日在本周末前、落在可跑日）。用户禁止双练时目标日
    // 必须真的空着——落在已有轻松跑的一天就是造出一个双练日（devops#1054：112km
    // 周 >110km，此前只查了「不是质量课日」，P5 的周量判据拦不住）；双练获准时可以叠
    const qHere = structuredAt.find((x) => x.di === di);
    if (qHere != null) {
      const qWds = structuredAt.map((x) => x.di);
      const lastBefore = qWds.filter((d) => d < di).at(-1) ?? -10;
      const firstAfter = qWds.filter((d) => d > di).at(0) ?? 7;
      const mayStack = doubleSessionAllowed(row.totalKm, DOUBLE_ADMISSION_KM, ctx.availability);
      const moveTarget =
        Array.from({ length: 4 - di }, (_, k) => di + 1 + k).find(
          (d) => isAvailable(d) && !qWds.includes(d) && (mayStack || !instantiated.some((x) => x.di === d)) && d - lastBefore >= 2 && firstAfter - d >= 2,
        ) ?? null;
      if (moveTarget != null) {
        qHere.di = moveTarget;
        qHere.workout = materializeCourse(qHere.course, dateOf(weekMonday, moveTarget));
        repairs.push(`W${row.week} ${DAY_LABELS[di]} 质量课挪至 ${DAY_LABELS[moveTarget]}（P6 比值收敛）`);
        // 叠到已有轻松课的日子：轻松课让出结构课占掉的时段
        for (const slot of instantiated) if (slot.di === moveTarget) slot.minutes = Math.min(slot.minutes, eLimitOf(moveTarget) ?? Infinity);
        byDay.length = 0;
        for (let d = 0; d < 7; d++) byDay.push([]);
        for (const { di: d, workout } of structuredAt) byDay[d]!.push(workout);
        instantiateWithNotes(instantiated);
        recompute();
        continue;
      }
    }
    const eIdx = instantiated.findLastIndex((x) => x.di === di);
    if (eIdx < 0) break;
    const x = instantiated[eIdx]!;
    const band = bandOf(x.flavor, x.di);
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

  // 终检口径 C1：按物化后的真实课表复核（与 validators.sessionKm 同式）。上面的
  // water-fill 账用未取整分钟，与 30s 取整后的课表有亚公里级差——卡在容差边的
  // 落位在分钟账上看不出来，必须在真实课表上判（devops#1043 候选枚举实证）
  const materializedKm = byDay.flat().reduce((sum, workout) => sum + (sessionKm(workout, eMid) ?? 0), 0);
  if (Math.abs(c1Target - materializedKm) > tol) {
    return {
      failures: [
        `W${row.week} 排位无解：C1 周量 ${round2(materializedKm)} vs 目标 ${c1Target}（±${tol.toFixed(1)}）——实例化取整后越界，课包结构课里程或槽数需调整`,
      ],
    };
  }

  const sessions = byDay.flat();
  const weeksToRace = ctx.race
    ? Math.max(1, Math.ceil((new Date(ctx.race.date).getTime() - new Date(mondayOf(weekMonday)).getTime()) / (7 * 86400000)) - 0)
    : null;
  const checks = scheduleGates({
    calendar,
    loadSeries,
    row,
    daysMax: ctx.athlete.weeklyRunDaysMax,
    raceDate,
    coefficients,
    weeksToRace,
    previousDayQuality: ctx.previousDayQuality === true,
    ...(ctx.availability != null ? { availability: ctx.availability } : {}),
  });
  if (checks.some((c) => !c.pass)) {
    return { failures: checks.filter((c) => !c.pass).map((c) => `W${row.week} ${c.id}：${c.detail}`) };
  }
  // 课包守恒终检（devops#1054）：最终物化课表对固定课包逐项对账——贪心落位、
  // 仲裁修复、模板兜底都经本函数，谁丢了课都在这里拦下
  const deviation = bagDeviationOf(row.week, input.bagCourses, dayCourses.flat(), sessions, isRaceWeek);
  if (deviation != null) return { failures: [deviation] };
  return { schedule: { week: row.week, sessions, calendar, loadSeries, checks, repairs }, pmc: state };
}

/**
 * 固定课包 vs 落位与最终物化课表（devops#1054）：结构课逐节在案（长跑与质量课配额；
 * 同型同名的课按节数对账——2Q 周可以有两节一样的课）；E 槽位数与落位一致（常规周
 * 排位阶段不剪课，E 只会在实例化里经仲裁置休/剪除减少，每一处都有留痕；赛周的赛前
 * 短 E 是激活点缀不是量载体，排位阶段按训练日帽剪除，不核对 E 账）。未获双练准入时
 * 课数=跑步日数由 P5 把关。无偏差=null。
 */
function bagDeviationOf(
  week: number,
  bag: readonly PlannedCourse[],
  placement: readonly PlannedCourse[],
  sessions: readonly RunWorkout[],
  isRaceWeek: boolean,
): string | null {
  const countOf = (items: readonly { type?: string | null | undefined; name: string }[]): Map<string, { name: string; count: number }> => {
    const counts = new Map<string, { name: string; count: number }>();
    for (const { type, name } of items) {
      const entry = counts.get(`${type}:${name}`);
      if (entry) entry.count++;
      else counts.set(`${type}:${name}`, { name, count: 1 });
    }
    return counts;
  };
  const expected = countOf(bag.filter((course): course is StructuredCourse => course.kind === "course"));
  const placed = countOf(sessions.filter((workout) => workout.type !== "E"));
  for (const key of new Set([...expected.keys(), ...placed.keys()])) {
    const want = expected.get(key)?.count ?? 0;
    const got = placed.get(key)?.count ?? 0;
    if (want !== got) return `W${week} 结构课 ${(expected.get(key) ?? placed.get(key))!.name} 课包 ${want} 节、物化课表 ${got} 节——最终课表与课包不符`;
  }
  if (isRaceWeek) return null;
  const bagSlots = bag.filter((course) => course.kind === "e-slot").length;
  const placedSlots = placement.filter((course) => course.kind === "e-slot").length;
  return bagSlots === placedSlots ? null : `W${week} E 槽位与课包不符：课包 ${bagSlots} 个、落位 ${placedSlots} 个——最终课表与课包不符`;
}

// ── 整段入口：日期分布优化 + 跨周边界 ──

type ScheduledWeek = { schedule: WeekSchedule; pmc: PmcState; distribution: WeekDistributionAudit[] };
/** 单周排位成功：schedule + 该周选定的候选下标，以及还没试过的可执行候选数（赛周=0）。 */
type ScheduledChoice = ScheduledWeek & { chosen: number; untried: number };
type WeekFailure = { failures: string[]; conflicts?: string[] };

type Evaluated = { index: number; dayCourses: PlannedCourse[][]; result: ReturnType<typeof instantiateWeek> };
type ScheduledCandidate = Evaluated & { result: Extract<ReturnType<typeof instantiateWeek>, { schedule: WeekSchedule }> };
const isScheduled = (candidate: Evaluated): candidate is ScheduledCandidate => "schedule" in candidate.result;
const failuresOf = (candidate: Evaluated): string[] => ("failures" in candidate.result ? candidate.result.failures : []);

/** 保课量序：课数优先、跑步日数次之（≤8 的进位保证字典序）。 */
const keepRank = (schedule: WeekSchedule): number => schedule.sessions.length * 8 + new Set(schedule.sessions.map((workout) => workout.date)).size;

/** 选定候选相对被淘汰候选改善的指标（审计原因用）。 */
function improvementsOf(from: DistributionMetrics, to: DistributionMetrics): string {
  const parts = [
    to.longestRun.days < from.longestRun.days ? `最长连跑 ${from.longestRun.days}→${to.longestRun.days} 天` : null,
    to.longestRest.days < from.longestRest.days ? `最长连休 ${from.longestRest.days}→${to.longestRest.days} 天` : null,
    to.maxKey3DayLoad != null && from.maxKey3DayLoad != null && to.maxKey3DayLoad < from.maxKey3DayLoad
      ? `含关键课三日负荷峰 ${from.maxKey3DayLoad}→${to.maxKey3DayLoad}`
      : null,
  ];
  return parts.filter((part): part is string => part != null).join("、");
}

/** 候选失败清单去重：不同候选常以近似文本挂同一道门，按开头片段只留第一条。 */
function dedupeFailures(failures: string[]): string[] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    const key = failure.replace(/^W\d+ /, "").slice(0, 14);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 约束现状：集中若仍在，说明由什么造成（审计据此报告具体原因，不警告放行）。 */
function constraintsOf(weeklyRunDaysMax: number, availability: AvailabilityConstraints | undefined, runDayCount: number): string[] {
  const available = availability?.availableWeekdays ?? null;
  const daysMax = effectiveDaysMaxOf(weeklyRunDaysMax, availability);
  return [
    available == null ? "具体可跑日未知（仅每周天数上限）" : available.length === 0 ? "没有可跑日" : `可跑日=周${weekdaysLabel(available)}`,
    runDayCount >= daysMax ? `已达每周跑步日上限 ${daysMax}` : null,
    "长跑固定周日、周六仅轻量 E",
  ].filter((constraint): constraint is string => constraint != null);
}

/**
 * 用户可用度与课包/位型的硬冲突说明（devops#1043「返回受冲突的日期和约束」）：
 * 全部候选不过门时把原因落在真正的约束上，而不是被它连带出来的周量/时长带
 * 违规。无冲突=null。（课包装不进训练日容量的冲突在排位阶段就上浮，见
 * bagCapacityConflictOf。）
 */
function availabilityConflictOf(bag: WeekBag, row: ContentWeekRow, ctx: SingleWeekContext): string | null {
  const availability = ctx.availability;
  const available = availability?.availableWeekdays ?? null;
  const structured = bag.courses.filter((course): course is StructuredCourse => course.kind === "course");
  // 课包里有长跑而周日不可跑（排位阶段已带着同一冲突返回；没带长跑的课包不该报它）
  if (structured.some((course) => course.type === "LR")) {
    const longRunConflict = longRunDayConflictOf(row, available);
    if (longRunConflict != null) return longRunConflict;
  }
  if (row.role !== "race") {
    // 普通轻松课（≥60min）在可跑平日的时窗里排不出：可跑平日最长的一段时窗容不下
    // 它的下限（减量/恢复周的 E 走短带，不受此限）
    const weekdays = [0, 1, 2, 3, 4].filter((di) => isAvailableDay(available, di));
    const longestWindow = Math.max(0, ...weekdays.map((di) => availability?.windowMinutes?.[di] ?? 0));
    if (row.role !== "taper" && row.phase !== "recovery" && longestWindow > 0 && longestWindow < E_DURATION_NORMAL_BAND[0])
      return `W${row.week} 可跑平日的可训练时段最长 ${longestWindow}min，低于普通轻松课下限 ${E_DURATION_NORMAL_BAND[0]}min——普通 E 日无法在许可时长内排课`;
  }
  // 结构课装不进可训练时段（devops#1054）：日内时窗对结构课同样是硬约束——长跑
  // 固定周日，带日期报；其余结构课在可跑平日里找不到一天容得下。赛周只看比赛课
  // 以外的课（比赛日是固定事件，不受限）
  const coefficients = ctx.coefficients ?? DEFAULT_DOSE_COEFFICIENTS;
  const raceCourse = row.role === "race" ? raceCourseOf(structured, row, coefficients) : null;
  const eMid = easyMidOf(row);
  for (const course of structured) {
    if (course === raceCourse) continue;
    const minutes = elapsedMinutes(materializeCourse(course, "2000-01-03"), eMid);
    if (minutes == null) continue;
    if (course.type === "LR") {
      const window = windowLimitOf(availability, 6);
      if (window != null && window < minutes)
        return `W${row.week} ${course.name}≈${Math.round(minutes)}min 超出周日（${dateOf(mondayOf(ctx.weekMonday), 6)}）的可训练时段（时窗 ${window}min）`;
      continue;
    }
    const days = [0, 1, 2, 3, 4].filter((di) => isAvailableDay(available, di));
    // 没声明时窗的日子按不限（Infinity）算
    const windows = days.map((di) => windowLimitOf(availability, di) ?? Infinity);
    if (windows.length === 0 || windows.some((window) => window >= minutes)) continue;
    return `W${row.week} ${course.name}≈${Math.round(minutes)}min 超出可跑日（${weekdaysLabel(days)}）的可训练时段（最长 ${Math.max(...windows)}min）`;
  }
  return null;
}

/**
 * 常规周日期分布选择（devops#1043）：贪心落位=基准（candidates[0]）；枚举同课数、
 * 同跑步日数的替代落位，逐个走 instantiateWeek（实例化+P 门+C 门），只用过门且与
 * 基准同形态的候选比三项分布指标（被超过的淘汰；有取舍时先保护关键课附近的
 * 恢复，再比日期分布）。全部候选不过门=硬约束无解，带受冲突的约束上浮。
 *
 * rejected（devops#1054）=已试过、让后续周排位无解的候选（下标 → 原因）：可执行
 * =过硬约束且未被否决；只在可执行候选里比分布。返回还没试过的可执行候选数
 * （untried）——后续周仍排不出时 scheduleWeeks 据此改选。
 */
function scheduleDistributedWeek(
  bag: WeekBag,
  row: ContentWeekRow,
  ctx: SingleWeekContext,
  pmc: PmcState,
  scope: { prefix: DayFact[]; suffix: DayFact[] | null },
  rejected: ReadonlyMap<number, string>,
): ScheduledChoice | WeekFailure {
  const coefficients = ctx.coefficients ?? DEFAULT_DOSE_COEFFICIENTS;
  const weekMonday = mondayOf(ctx.weekMonday);
  const placementRepairs: string[] = [];
  const placement = placeNormalWeek(bag, row, ctx, coefficients, pmc, placementRepairs);
  if (placement.failures.length > 0) return { failures: placement.failures, conflicts: placement.conflicts };
  const evaluated: Evaluated[] = enumeratePlacements(placement.dayCourses, ctx.availability?.availableWeekdays ?? null).map((dayCourses, index) => ({
    index,
    dayCourses,
    result: instantiateWeek({ dayCourses, row, ctx, weekMonday, raceWd: null, raceDate: null, pmc, repairs: [...placementRepairs], bagCourses: bag.courses }),
  }));
  // 排位后课程校验（C 门）逐候选复算：按落位判定的门（如 E 时长分层 C9）只有过完
  // 实例化后的真实课表才判得出（周量 C1 已在 instantiateWeek 内按物化结果复核）
  for (const candidate of evaluated) {
    if (!("schedule" in candidate.result)) continue;
    const failed = (ctx.validateWeek?.(candidate.result.schedule.sessions, row) ?? []).filter((check) => !check.pass);
    if (failed.length > 0) candidate.result = { failures: failed.map((check) => `W${row.week} ${check.id}：${check.detail}`) };
  }
  const isExecutable = (candidate: Evaluated): candidate is ScheduledCandidate => isScheduled(candidate) && !rejected.has(candidate.index);
  const rejectionOf = (candidate: Evaluated): string[] => (rejected.has(candidate.index) ? [`使后续周排位无解（${rejected.get(candidate.index)}）`] : []);
  const executable = evaluated.filter(isExecutable);
  if (executable.length === 0) {
    // 过硬约束的候选都被后续周否决：本周排得出，只是没有不连累后面的排法
    const vetoed = evaluated.find(isScheduled);
    if (vetoed != null) return { failures: [`W${row.week} 日期分布候选均使后续周排位无解（${rejected.get(vetoed.index)}）`] };
    // 无解原因落在真正的约束上：用户可用度冲突置首位（编排层据此归类结构性无解）
    const conflict = availabilityConflictOf(bag, row, ctx);
    return {
      failures: [...(conflict == null ? [] : [conflict]), ...dedupeFailures(evaluated.flatMap(failuresOf))],
      conflicts: conflict == null ? [] : [conflict],
    };
  }
  // 形态基准：贪心解可执行=保持它的课数/跑步日数；否则=可执行候选里保课最多的形态
  const base = evaluated[0]!;
  const reference = isExecutable(base) ? keepRank(base.result.schedule) : Math.max(...executable.map((candidate) => keepRank(candidate.result.schedule)));
  const metricsOf = (schedule: WeekSchedule): DistributionMetrics => contextMetrics(scope.prefix, factsOfWeek(schedule, row.zones, null), scope.suffix);
  const scored = executable
    .filter((candidate) => keepRank(candidate.result.schedule) === reference)
    .map((candidate) => ({ index: candidate.index, metrics: metricsOf(candidate.result.schedule), dominatedBy: null as number | null }));
  for (const entry of scored) entry.dominatedBy = scored.find((other) => other !== entry && dominates(other.metrics, entry.metrics))?.index ?? null;
  // 取舍序：非被超过的前沿在前（关键课次日恢复 → 连休 → 连跑），其后是被超过的候选
  const ranked = scored
    .slice()
    .sort((a, b) => Number(a.dominatedBy != null) - Number(b.dominatedBy != null) || compareCandidates(a.metrics, b.metrics) || a.index - b.index);
  const chosen = ranked[0];
  if (chosen == null) return { failures: [`W${row.week} 排位无解：没有可比较的日期分布候选`] };
  const chosenCandidate = executable.find((candidate) => candidate.index === chosen.index)!;
  const baseline = scored.find((entry) => entry.index === base.index) ?? null;
  const comparison =
    chosen.index === base.index
      ? "贪心落位在同形态可行候选中未被超过，保持"
      : baseline == null
        ? `贪心解不过硬约束（${failuresOf(base).join(";")}）；在保课最多的可行形态里取分布最优`
        : dominates(chosen.metrics, baseline.metrics)
          ? `淘汰贪心解：三项均不差且 ${improvementsOf(baseline.metrics, chosen.metrics)} 更好`
          : `有取舍——先保护关键课附近恢复、再比日期分布，选定（${formatDistributionMetrics(chosen.metrics)}）优于贪心解（${formatDistributionMetrics(baseline.metrics)}）`;
  // 有候选被后续周否决时，先说明这件事，再接原有的比较说明
  const reason = (rejected.size > 0 ? `优先候选使后续周排位无解（${[...rejected.values()][0]}），只在可执行候选里比较；` : "") + comparison;
  const runDayCount = new Set(chosenCandidate.result.schedule.sessions.map((workout) => workout.date)).size;
  const candidates: DistributionCandidateAudit[] = evaluated.map((candidate) => {
    const entry = scored.find((item) => item.index === candidate.index);
    return {
      label: placementLabel(candidate.dayCourses),
      runDays: runDaysOf(candidate.dayCourses),
      feasible: isExecutable(candidate),
      failures: [...failuresOf(candidate), ...rejectionOf(candidate)],
      metrics: entry?.metrics ?? null,
      dominatedBy: entry?.dominatedBy ?? null,
    };
  });
  return {
    schedule: chosenCandidate.result.schedule,
    pmc: chosenCandidate.result.pmc,
    chosen: chosen.index,
    untried: ranked.length - 1,
    distribution: [
      {
        week: row.week,
        chosen: chosen.index,
        prefix: scope.prefix,
        suffix: scope.suffix,
        reason,
        constraints: constraintsOf(ctx.athlete.weeklyRunDaysMax, ctx.availability, runDayCount),
        finalMetrics: chosen.metrics,
        converged: false,
        candidates,
      },
    ],
  };
}

interface BatchPass {
  weeks: WeekSchedule[];
  distribution: WeekDistributionAudit[];
  failures: string[];
  conflicts: string[];
}

/** 交界复核的前向遍数上限：每遍至多把变化往前推一周，批长 +1 遍足以到不动点。 */
const MAX_DISTRIBUTION_PASSES = 8;
/**
 * 回溯改选的次数上限（devops#1054）：改选空间是各周候选数的乘积，不能无界枚举
 * ——超出的批交回贪心回退（全贪心组合可行时仍能出课表）。单周候选数最多百级
 * （五跑周 72），120 保证只涉及一个可变周时一定搜得完。
 */
const MAX_BACKTRACKS = 120;

/**
 * 课包集合校验（devops#1054「周课包先校验集合」）：周号须与骨架行一一对应——骨架
 * 外的周、重复的周、缺课包的周都先报，不带着残缺的集合去排位。
 */
function bagSetFailuresOf(bags: readonly WeekBag[], rows: readonly ContentWeekRow[]): string[] {
  const rowWeeks = new Set(rows.map((row) => row.week));
  const bagWeeks = bags.map((bag) => bag.week);
  return [
    ...bagWeeks.filter((week) => !rowWeeks.has(week)).map((week) => `W${week} 不在骨架行内`),
    ...[...new Set(bagWeeks.filter((week, index) => bagWeeks.indexOf(week) !== index))].map((week) => `W${week} 课包重复`),
    ...rows.filter((row) => !bagWeeks.includes(row.week)).map((row) => `W${row.week} 缺课包`),
  ];
}

export function scheduleWeeks(bags: WeekBag[], ctx: ScheduleContext): ScheduleResult {
  const coefficients = ctx.coefficients ?? DEFAULT_DOSE_COEFFICIENTS;
  const rowOfWeek = new Map(ctx.rows.map((r) => [r.week, r]));
  const factsOf = (schedule: WeekSchedule): DayFact[] => {
    const row = rowOfWeek.get(schedule.week)!;
    return factsOfWeek(schedule, row.zones, row.role === "race" ? ctx.race.date : null);
  };
  const mondayOfWeek = (row: ContentWeekRow): string => mondayOf(dateOf(ctx.planStartMonday, (row.week - 1) * 7));
  const weekContextOf = (row: ContentWeekRow, prefix: DayFact[]): SingleWeekContext => ({
    weekMonday: mondayOfWeek(row),
    race: ctx.race,
    athlete: ctx.athlete,
    coefficients,
    previousDayQuality: prefix[6]!.quality === true,
    ...(ctx.validateWeek != null ? { validateWeek: ctx.validateWeek } : {}),
    ...(ctx.availability != null ? { availability: ctx.availability } : {}),
  });
  /** 赛周不做分布比较（比赛日固定、激活窗/通勤日是既有赛周例外），无留痕、无可改选的候选。 */
  const raceWeekOf = (bag: WeekBag, row: ContentWeekRow, weekCtx: SingleWeekContext, pmc: PmcState): ScheduledChoice | WeekFailure => {
    const result = scheduleWeek(bag, row, weekCtx, pmc);
    if ("schedule" in result) return { schedule: result.schedule, pmc: result.pmc, distribution: [], chosen: 0, untried: 0 };
    // 赛周排不出时同样把属于用户可用度的冲突（激活课超时窗等）置首位——编排层据
    // conflicts 归类结构性无解，否则会被当成「超排位包络」
    const conflict = result.conflicts?.[0] ?? availabilityConflictOf(bag, row, weekCtx);
    return conflict == null ? result : { failures: [conflict, ...result.failures], conflicts: [conflict] };
  };
  /** 批首周之前 7 天的边界前缀（整批指标与贪心回退留痕用）。 */
  const firstPrefix = (weeks: WeekSchedule[], index: number, row: ContentWeekRow): DayFact[] => {
    // 批内前面的周失败时不入 weeks：拿不到紧邻上一周就退回已知边界
    const previous = weeks[index - 1];
    return previous != null && previous.week === row.week - 1 ? factsOf(previous) : boundaryPrefix(ctx.boundary, mondayOfWeek(row));
  };
  const loadMeta: LoadMeta = {
    model: "exp-pmc-7-42",
    seed: { acute: ctx.pmcSeed.acute, chronic: ctx.pmcSeed.chronic, source: "生成时点直读生产 PMC 当日快照（daily_training_load.acute_load/chronic_load）" },
    coefficient_version: coefficients === DEFAULT_DOSE_COEFFICIENTS ? COEFFICIENT_VERSION : "custom",
  };

  // 课包先校验集合，再按周序推进负荷（devops#1054）：传入顺序不决定排位顺序——
  // 负荷沿日期正向传递，跨周判定（P2 的上周日质量课）看到的才是真正的上一周
  const bagFailures = bagSetFailuresOf(bags, ctx.rows);
  if (bagFailures.length > 0) return { weeks: [], distribution: [], loadMeta, ok: false, failures: bagFailures, conflicts: [] };
  const ordered = [...bags].sort((a, b) => a.week - b.week);
  const backtrackLimit = ctx.backtrackLimit ?? MAX_BACKTRACKS;

  /**
   * 一遍前向；suffixOf=前一遍排出的下一周事实（首遍=下一周未知）。某周排不出时
   * 优先调整可变周（devops#1054）：回到最近的可变周（有分布候选的常规周）改选
   * 下一个候选、重排其后各周——后续周因负荷轨迹失效时，不再直接整批回退到被
   * 其他可执行组合超过的排法；回溯预算用尽或没有候选可换才判本遍无解。
   */
  const run = (suffixOf: ((week: number) => DayFact[] | null) | null): BatchPass => {
    const pass: BatchPass = { weeks: [], distribution: [], failures: [], conflicts: [] };
    const chosen: Array<ScheduledChoice | undefined> = ordered.map(() => undefined);
    /** 被后续周否决的候选（下标 → 原因）：只在给定前缀下成立，前缀一改就作废。 */
    const rejected: Array<Map<number, string>> = ordered.map(() => new Map());
    let index = 0;
    let pmc: PmcState = { ...ctx.pmcSeed };
    let backtracks = 0;
    /** 首选组合的失败原因：预算用尽时报它，而不是最后一个被否决组合的。 */
    let firstFailure: WeekFailure | null = null;
    while (index < ordered.length) {
      const bag = ordered[index]!;
      const row = rowOfWeek.get(bag.week)!;
      // 前缀=上一周排位产物（批内连续周）或已知边界日历（首周接历史/上一批末周）
      const prefix = firstPrefix(pass.weeks, index, row);
      const weekCtx = weekContextOf(row, prefix);
      const result =
        row.role === "race"
          ? raceWeekOf(bag, row, weekCtx, pmc)
          : scheduleDistributedWeek(bag, row, weekCtx, pmc, { prefix, suffix: suffixOf == null ? null : suffixOf(row.week + 1) }, rejected[index]!);
      if ("failures" in result) {
        firstFailure ??= result;
        let back = index - 1;
        while (back >= 0 && (chosen[back]?.untried ?? 0) === 0) back--;
        if (back < 0 || backtracks >= backtrackLimit) {
          pass.failures.push(...firstFailure.failures);
          pass.conflicts.push(...(firstFailure.conflicts ?? []));
          return pass;
        }
        backtracks++;
        rejected[back]!.set(chosen[back]!.chosen, result.failures[0]!);
        for (let later = back + 1; later < ordered.length; later++) rejected[later]!.clear();
        pass.weeks.length = back;
        pass.distribution = pass.distribution.filter((audit) => audit.week < ordered[back]!.week);
        pmc = chosen[back - 1]?.pmc ?? { ...ctx.pmcSeed };
        index = back;
        continue;
      }
      pass.weeks[index] = result.schedule;
      pass.distribution.push(...result.distribution);
      chosen[index] = result;
      pmc = result.pmc;
      index++;
    }
    return pass;
  };
  /** 贪心批（不做分布比较）：改选也排不出时的回退日历；留痕只记贪心候选与回退原因。 */
  const greedyPass = (why: string): BatchPass => {
    const pass: BatchPass = { weeks: [], distribution: [], failures: [], conflicts: [] };
    let pmc: PmcState = { ...ctx.pmcSeed };
    for (const bag of ordered) {
      const row = rowOfWeek.get(bag.week)!;
      const result = scheduleWeek(bag, row, weekContextOf(row, firstPrefix(pass.weeks, pass.weeks.length, row)), pmc);
      if ("failures" in result) {
        pass.failures.push(...result.failures);
        pass.conflicts.push(...(result.conflicts ?? []));
        break;
      }
      pmc = result.pmc;
      pass.weeks.push(result.schedule);
    }
    if (pass.failures.length > 0) return pass;
    pass.distribution = pass.weeks.flatMap((schedule, index) => {
      const row = rowOfWeek.get(schedule.week)!;
      if (row.role === "race") return [];
      const prefix = firstPrefix(pass.weeks, index, row);
      const suffix = pass.weeks[index + 1] == null ? null : factsOf(pass.weeks[index + 1]!);
      const facts = factsOf(schedule);
      return [
        {
          week: row.week,
          chosen: 0,
          prefix,
          suffix,
          reason: `${why}；回退到贪心日历（不做日期分布比较）`,
          constraints: constraintsOf(ctx.athlete.weeklyRunDaysMax, ctx.availability, facts.filter((day) => day.run).length),
          finalMetrics: contextMetrics(prefix, facts, suffix),
          converged: true,
          candidates: [
            {
              label: scheduleLabel(schedule),
              runDays: facts.flatMap((day, weekday) => (day.run ? [weekday] : [])),
              feasible: true,
              failures: [],
              metrics: contextMetrics(prefix, facts, suffix),
              dominatedBy: null,
            },
          ],
        },
      ];
    });
    return pass;
  };

  let accepted = run(null);
  // 交界复核（devops#1043「后续周补齐时复核交界，只调整可变日期」）：以后一遍为
  // 前视重排。单看一周的改善可能让相邻周变差——按整批（含边界）的分布指标判：
  // 四项均不变差才采纳，否则停在上一遍；选择不再变化=不动点（留痕与最终日历
  // 一致）。任一周不过门同样停在上一遍。
  const metricsOfPass = (pass: BatchPass): DistributionMetrics =>
    distributionMetrics([...boundaryPrefix(ctx.boundary, mondayOfWeek(rowOfWeek.get(ordered[0]!.week)!)), ...pass.weeks.flatMap(factsOf)]);
  for (let pass = 2; accepted.failures.length === 0 && ordered.length > 1 && pass <= Math.min(ordered.length + 1, MAX_DISTRIBUTION_PASSES); pass++) {
    const lookahead = new Map(accepted.weeks.map((schedule) => [schedule.week, factsOf(schedule)]));
    const next = run((week) => lookahead.get(week) ?? null);
    if (next.failures.length > 0) break;
    if (next.weeks.length === accepted.weeks.length && next.weeks.every((schedule, index) => sameFacts(factsOf(schedule), factsOf(accepted.weeks[index]!)))) {
      accepted = next;
      break;
    }
    if (!noWorseBatch(metricsOfPass(next), metricsOfPass(accepted))) break;
    accepted = next;
  }
  // 改选可变周之后整批仍无解而贪心日历可行：不让优化把原本可行的批变无解——
  // 回退贪心日历并留痕
  if (accepted.failures.length > 0) {
    const greedy = greedyPass(`分布优化后的日历排位无解（${accepted.failures[0]}）`);
    if (greedy.failures.length === 0) accepted = greedy;
  }
  // 留痕按最终日历落定：finalMetrics=选定候选在最终前后周下的指标（审计文字用
  // 它）；选择时依据的下一周与最终不同=交界复核未收敛，如实标注
  const finalFacts = new Map(accepted.weeks.map((schedule, index) => [schedule.week, { facts: factsOf(schedule), index }]));
  for (const audit of accepted.distribution) {
    const week = finalFacts.get(audit.week)!;
    const row = rowOfWeek.get(audit.week)!;
    audit.finalMetrics = contextMetrics(firstPrefix(accepted.weeks, week.index, row), week.facts, finalFacts.get(audit.week + 1)?.facts ?? null);
    audit.converged = sameFacts(audit.suffix, finalFacts.get(audit.week + 1)?.facts ?? null);
    if (!audit.converged) audit.reason = `${audit.reason}；交界复核未收敛（选择时依据的下一周与最终日历不同）`;
  }
  return {
    weeks: accepted.weeks,
    distribution: accepted.distribution,
    loadMeta,
    ok: accepted.weeks.length === ordered.length && accepted.failures.length === 0,
    failures: accepted.failures,
    conflicts: accepted.conflicts,
  };
}

/**
 * R0 夜复盘微调入口（ticket #4：换日/单课减量只重跑本段不碰 LLM）。
 * 输入改后的课包 + 当日 PMC 快照 → 该周日历/load_series；无解返回 failures。
 */
export function scheduleOnly(bag: WeekBag, row: ContentWeekRow, ctx: SingleWeekContext, pmcSnapshot: PmcState): WeekSchedule | { failures: string[] } {
  const result = scheduleWeek(bag, row, ctx, pmcSnapshot);
  return "schedule" in result ? result.schedule : { failures: result.failures };
}
