import type { PhaseCanonical, PhaseDivisionIntent } from "../intent.js";
import { phaseRefMatches } from "../intent.js";
import type { HabitualBaseline } from "./baseline.js";
import { type LoadCheck, validateLoad } from "./gates.js";
import { BUILD_CAP, bandOf, RECOVERY_FACTOR, RECOVERY_FLOOR_KM } from "./reachability.js";

/**
 * 载荷展开器（devops#793，daniels-l3-load.md §2.2-§2.5）：把 L2 阶段划分
 * （结构+体量带+块模式+taper 属性）确定性翻译成每周跑多少、多难、按什么节奏。
 * 零 LLM——判断已全部住在 L2，本层在带内做构造；ACWR 帽是唯一真约束，
 * 构造层次级规则与帽冲突时一律让帽（恢复期后爬坡缓是科学正确形态）。
 *
 * 产出五件（spec §3）：周骨架（默认轨迹）/ 块结构标记 / 回补策略（政策面）/
 * 力量指导 policy / 边界检查+里程碑对齐。不含 kernel/weekly graph 接入（另票）、
 * 不含 L4 内容层与执行回路。
 */

/** 构造物理常量（BUILD_CAP/RECOVERY_*）单源在 reachability.ts（展开器与 L2 可达性包络共用）。 */
/** 吸收周：全局建设周计数每第 4 周 ×0.75（跨阶段不重置；计数含吸收周自身）。 */
const ABSORB_EVERY = 4;
const ABSORB_FACTOR = 0.75;
/** taper 曲线削至赛周：缺省削减 40%（30-50% 带内），赛周=比赛+激活。 */
const TAPER_CURVE = 0.45;
/** 赛周 km=训练负荷投影（0.55×平台，非字面里程账——比赛与激活的课表归 L4 内容层排）。 */
const RACE_FRACTION = 0.55;
/** 块内微阶梯（质感项）：三周 0.97/1/1.03 微递进而非平台直排。 */
const STAIR: readonly number[] = [0.97, 1, 1.03];
/** LR 曲线：峰值 ≤32；份额 ≤36%（周量 <60km 放宽 42%）；低量档下限随峰下调。 */
const LR_MAX_KM = 32;
const LR_SHARE = 0.36;
const LR_SHARE_LOW_VOLUME = 0.42;
const LR_LOW_VOLUME_WEEK_KM = 60;
const LR_FLOOR_KM = 22;
/** LR 运行下限（km）：低量周让位于份额上限（min(12, km×cap)），不硬顶破份额门。 */
const LR_MIN_KM = 12;
/** Q 配额（spec §2.4）：recovery=0｜foundation km≥60→1 否则 0｜其余建设 km≥70→2 否则 1｜taper/赛周=1。 */
const Q_FOUNDATION_KM = 60;
const Q_BUILD_KM = 70;

const r1 = (x: number) => Math.round(x * 10) / 10;

export type LoadRole = "progress" | "absorb" | "taper" | "race";

/** 周骨架行（默认轨迹；spec §3 产出物 1，实测定型行结构）。 */
export interface LoadWeek {
  week: number;
  canonical: PhaseCanonical;
  block: number;
  role: LoadRole;
  km: number;
  /** 长跑（km）；赛周 null（比赛本身不算训练长跑）。 */
  lr: number | null;
  /** 质量课配额。 */
  q: number;
}

/** 块结构标记（spec §3 产出物 2）：3+1 边界与块角色，R2 校准挂点。 */
export interface LoadBlock {
  block: number;
  canonical: PhaseCanonical;
  start_week: number;
  end_week: number;
  /** 块内吸收周（3+1 的「1」；空=纯相位块）。 */
  absorb_weeks: number[];
  /** phase_start=相位切换开块；absorb_cut=吸收周自身开新块。 */
  boundary: "phase_start" | "absorb_cut";
}

/** 回补策略场景（spec §3 产出物 3，政策面数据，R2 直接读取）。 */
export interface RecoveryScenarioPolicy {
  id: "normal" | "fatigue" | "overshoot";
  /** 触发信号条件。 */
  trigger: string;
  action: string;
  /** 降周/增量深度。 */
  depth: string;
}

/** 力量指导 policy（spec §3 产出物 4，阶段级方向规则；实质课表在 weekly plan）。 */
export interface StrengthPhasePolicy {
  canonical: PhaseCanonical;
  strength_focus: string;
  /** 强度家族（canonical 直映射；冬季 transition_quality 以 T 为主）。 */
  quality_family: string;
  /** strides 副课标记（不算质量课）。 */
  strides_note: string;
}

/** 里程碑对齐（spec §3 产出物 5b）：L2 出口里程碑落到周序号。 */
export interface MilestoneAlignment {
  phase: string;
  signal: string;
  criterion: string;
  /** 该阶段出口周（end_week）。 */
  week: number;
}

export interface LoadPlan {
  /** 产出物 1：周骨架（默认轨迹）。 */
  weeks: LoadWeek[];
  /** 产出物 2：块结构标记。 */
  blocks: LoadBlock[];
  /** 产出物 3：回补策略（政策面）。 */
  recovery_policy: RecoveryScenarioPolicy[];
  /** 产出物 4：力量指导 policy + 强度家族/strides 标记。 */
  strength_policy: StrengthPhasePolicy[];
  /** 产出物 5a：边界检查结果（六条验收门）。 */
  checks: LoadCheck[];
  /** 产出物 5b：里程碑对齐。 */
  milestones: MilestoneAlignment[];
}

export interface LoadInput {
  intent: PhaseDivisionIntent;
  runwayWeeks: number;
  /** R0-R5 常态基线（evidence.habitual）。 */
  baseline: HabitualBaseline;
  /** 赛前实际完成周序列（补零口径，取末 4 周作滚动均值种子）。 */
  recentWeeksKm: number[];
}

const RECOVERY_POLICY: RecoveryScenarioPolicy[] = [
  {
    id: "normal",
    trigger: "块边界体感/RPV 正常，周量落带内",
    action: "常规递进：下一块块位承接，块间增量 +3~8%",
    depth: "+3~8%/块（ACWR 帽 1.28 内）",
  },
  {
    id: "fatigue",
    trigger: "连续 2 次 RPE≥8 或 HRV 偏离基线 −8% 以上",
    action: "重复当前块块位（不递进），质量课减一节",
    depth: "降周 22~30%；疲劳警戒（连续超量信号）降周 ≥35%",
  },
  {
    id: "overshoot",
    trigger: "周量超带 +10% 且课后 24h 体感 ≤5",
    action: "放大下一块步长，仍受 ACWR 帽 1.28 约束",
    depth: "步长至 +8% 封顶",
  },
];

const STRENGTH_POLICY: StrengthPhasePolicy[] = [
  {
    canonical: "recovery",
    strength_focus: "维持性核心与伤区康复负荷，不加新刺激",
    quality_family: "无质量课（纯 E + strides 触感）",
    strides_note: "strides 为副课标记，不计质量课",
  },
  {
    canonical: "foundation",
    strength_focus: "核心+下肢力量打底（2 次/周），配合量爬升",
    quality_family: "E 为主；速度触感靠 strides 副课",
    strides_note: "每周 1-2 组 strides，不计质量课",
  },
  {
    canonical: "early_quality",
    strength_focus: "力量维持 1-2 次/周，R 期神经负荷优先",
    quality_family: "R 重复（速度经济性）",
    strides_note: "R 课为主时 strides 并入热身，不单列",
  },
  {
    canonical: "transition_quality",
    strength_focus: "力量维持抗疲劳，T 课后 48h 内不练腿",
    quality_family: "I/T（冬季以 T 为主）",
    strides_note: "strides 为副课标记，不计质量课",
  },
  {
    canonical: "final_quality",
    strength_focus: "力量减量维持神经激活（1 次/周，赛前 10 天停）",
    quality_family: "M 配速比赛专项",
    strides_note: "赛前激活 strides 保留，不计质量课",
  },
];

/**
 * 滚动均值种子（展开器与验收门共用的单一真源）：=赛前 4 实际完成周；
 * ACWR 不适用（断练回归/零史回退——滚动均值被零周污染）时以起点构造位
 * （0.7×week_km）播种，避免 0km 周的荒谬轨迹。
 */
export function rollingSeed(baseline: HabitualBaseline, recentWeeksKm: number[]): number[] {
  if (baseline.acwr_applicable) return recentWeeksKm.slice(-4);
  const s = baseline.week_km * RECOVERY_FACTOR;
  return [s, s, s, s];
}

/** 展开主循环（全局贪心）：逐周前向构造，产出周骨架 + 块标记 + 里程碑对齐。 */
export function expandLoad(input: LoadInput): { weeks: LoadWeek[]; blocks: LoadBlock[]; milestones: MilestoneAlignment[] } {
  const { intent, runwayWeeks: N, baseline, recentWeeksKm } = input;
  const phases = [...intent.phases].sort((a, b) => a.start_week - b.start_week);
  const phaseAt = (w: number) => phases.find((p) => p.start_week <= w && w <= p.end_week) ?? phases.at(-1)!;
  const taperW = Math.min(intent.taper_weeks, 3);
  const actual4 = rollingSeed(baseline, recentWeeksKm);
  const lr8 = Math.max(LR_MIN_KM, Math.min(baseline.pre_peak_km * 0.32, 30));

  const weeks: LoadWeek[] = [];
  const phaseStartWeeks = new Set(phases.map((p) => p.start_week));
  let blockId = 0;
  let phaseWeekIdx = 0;
  let prevCanonical = "";
  for (let w = 1; w <= N; w++) {
    const p = phaseAt(w);
    if (p.canonical !== prevCanonical) {
      phaseWeekIdx = 0;
      prevCanonical = p.canonical;
    }
    phaseWeekIdx++;
    const band = bandOf(intent, p);
    const lo = band?.weekly_km_min ?? 10;
    const hi = band?.weekly_km_max ?? 120;
    const fromEnd = p.end_week - w;
    const inTaper = p.canonical === "final_quality" && fromEnd < taperW;
    const isRace = w === N;
    // 吸收周：全局建设周计数每第 4 周（计数含吸收周自身——spike 实测死循环陷阱；
    // recovery 不计入；跨阶段不重置——相位内计数会在短阶段漏排）
    const buildSoFar = weeks.filter((x) => x.canonical !== "recovery" && (x.role === "progress" || x.role === "absorb")).length;
    const absorb = !inTaper && p.canonical !== "recovery" && buildSoFar > 0 && (buildSoFar + 1) % ABSORB_EVERY === 0;
    if (phaseWeekIdx === 1 || absorb) blockId++;
    const prev4 = [...actual4, ...weeks.map((x) => x.km)].slice(-4);
    const rollMean = prev4.reduce((s, x) => s + x, 0) / Math.max(1, prev4.length);

    let km: number;
    let role: LoadRole;
    if (p.canonical === "recovery") {
      km = Math.min(lo, Math.max(RECOVERY_FLOOR_KM, baseline.week_km * RECOVERY_FACTOR));
      role = "progress";
    } else if (inTaper) {
      const tIdx = taperW - fromEnd;
      const plateau = weeks.filter((x) => x.canonical === "final_quality" && x.role === "progress").at(-1)?.km ?? Math.min(hi, rollMean);
      km = isRace ? plateau * RACE_FRACTION : plateau * (1 - (TAPER_CURVE * tIdx) / (taperW + 1));
      role = isRace ? "race" : "taper";
    } else {
      const stair = STAIR[(phaseWeekIdx - 1) % STAIR.length]!;
      const target = lo + 0.5 * (hi - lo); // 带中位：建设周的目标位
      km = Math.min(target * stair, BUILD_CAP * rollMean);
      km = Math.max(km, Math.min(lo, BUILD_CAP * rollMean)); // 能进带下限就进（ACWR 优先）
      role = absorb ? "absorb" : "progress";
      if (absorb) km *= ABSORB_FACTOR;
    }

    const lrCap = km < LR_LOW_VOLUME_WEEK_KM ? LR_SHARE_LOW_VOLUME : LR_SHARE;
    const lrFloor = Math.max(LR_FLOOR_KM, lr8 * 1.2);
    const lrTarget = Math.min(LR_MAX_KM, lrFloor, km * lrCap);
    // 下限 min(12, km×cap)：低量周（km≲27）份额优先，运行下限不再硬顶破份额门
    const lr = p.canonical === "recovery" || isRace ? (isRace ? null : r1(Math.min(14, km * 0.3))) : r1(Math.max(Math.min(LR_MIN_KM, km * lrCap), lrTarget));
    const q =
      p.canonical === "recovery" ? 0 : isRace || inTaper ? 1 : p.canonical === "foundation" ? (km >= Q_FOUNDATION_KM ? 1 : 0) : km >= Q_BUILD_KM ? 2 : 1;
    weeks.push({ week: w, canonical: p.canonical, block: blockId, role, km: r1(km), lr, q });
  }

  // 块结构标记：按块聚合，记录 3+1 边界与吸收周
  const blocks: LoadBlock[] = [];
  for (const wk of weeks) {
    const at = blocks.at(-1);
    if (at && at.block === wk.block) {
      at.end_week = wk.week;
      if (wk.role === "absorb") at.absorb_weeks.push(wk.week);
    } else {
      blocks.push({
        block: wk.block,
        canonical: wk.canonical,
        start_week: wk.week,
        end_week: wk.week,
        absorb_weeks: wk.role === "absorb" ? [wk.week] : [],
        boundary: phaseStartWeeks.has(wk.week) ? "phase_start" : "absorb_cut",
      });
    }
  }

  // 里程碑对齐：L2 里程碑挂到对应阶段的出口周（引用匹配必须用真实阶段行）
  const milestones: MilestoneAlignment[] = intent.milestones.map((m) => {
    const phase = phases.find((p) => phaseRefMatches(p, m.phase)) ?? phases.at(-1)!;
    return { phase: m.phase, signal: m.signal, criterion: m.criterion, week: phase.end_week };
  });

  return { weeks, blocks, milestones };
}

/** 生成入口：展开 + 六条验收门，产出完整五件套（门用与展开器同源的滚动种子）。 */
export function buildLoadPlan(input: LoadInput): LoadPlan {
  const { weeks, blocks, milestones } = expandLoad(input);
  const checks = validateLoad(input.intent, weeks, rollingSeed(input.baseline, input.recentWeeksKm));
  return {
    weeks,
    blocks,
    recovery_policy: RECOVERY_POLICY,
    strength_policy: STRENGTH_POLICY,
    checks,
    milestones,
  };
}
