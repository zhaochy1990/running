import type { LoadBlock, LoadPlan, LoadRole, LoadWeek, MilestoneAlignment, RecoveryScenarioPolicy, StrengthPhasePolicy } from "@stride/contract";
import type { PhaseDivisionIntent } from "../intent.js";
import { phaseRefMatches } from "../intent.js";
import type { HabitualBaseline } from "./baseline.js";
import { validateLoad } from "./gates.js";
import { ACTIVATION_MAX_KM, ACTIVATION_MIN_KM, BUILD_CAP, bandOf, RACE_KM, RECOVERY_FACTOR, RECOVERY_FLOOR_KM } from "./reachability.js";

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
/**
 * 赛周 km=比赛里程+激活（#806 弃 0.55×平台投影）：丹尼尔斯 FM 赛周激活原教义
 * 10-15km@MP（老 kernel skeletonPrompt 同款规则），激活量随平台位在带内缩放。
 * #809 低量档修复：字面最小值 42.2+10 优先于 0.7×ref 上限——低量跑者（峰
 * <~72.5km 时赛周 ≥52.2 必然越过 0.72×峰比值带、<~74.6km 时必然越过削减深度
 * 上界）比赛必然主导整周，上限夹持不得把赛周压到低于比赛里程本身（原双侧夹取
 * 会产出 37.8<42.2 的物理不可能赛周）。上限仅在高于字面最小值时生效（压高
 * 激活）；0.5×ref 下限随 #806 双侧夹取一并移除（>~114km 高平台回归纯字面账
 * ≤57.2，由 L4 门激活量右支兜底）。参照取门的 plateauRef 同款口径（FQ 非赛
 * 周最大 km，含 taper 周——fq≤taperW 的退化布局下无 progress 周，锚回退平
 * 台会劈叉）。
 */
import { RACE_DAILY_SHARE } from "./reachability.js";
/** 短跑道（≤8 周）禁用吸收周（#806 拍板①）：短块峰值后单调递减至赛周，全局 3+1 计数不注入短块。 */
const SHORT_ABSORB_MAX_WEEKS = 8;
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
/** taper 周 LR 削减（#809，真人教练 8 周对比拍板）：首 taper 周 25、每深一周 −5（带 20-25，由 taperW≤3 不变量保证）；race 周 lr=null 不变。 */
const TAPER_LR_MAX_KM = 25;
/** taper 周 2Q 量级门槛（km）：低于此保持 1Q——伤退/低量跑者减量周塞不下两节质量课（injury 36.5km 案例实证）。 */
const TAPER_Q2_MIN_KM = 60;
/** Q 配额（spec §2.4）：recovery=0｜foundation km≥60→1 否则 0｜其余建设 km≥70→2 否则 1｜taper km≥60→2 否则 1（2026-11-01 原书校准）｜赛周=2（#825：比赛课+激活短课）。 */
const Q_FOUNDATION_KM = 60;
const Q_BUILD_KM = 70;

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * 产物类型（LoadRole/LoadWeek/LoadBlock/…/LoadPlan）单源在 `@stride/contract`：
 * 政策包 v3 的 skeleton 段原样落库，schema 与生成侧不能各写一份（devops#855）。
 * 这里转出它们，phasing 内部与既有 import 不变。
 */
export type {
  LoadBlock,
  LoadPlan,
  LoadRole,
  LoadWeek,
  MilestoneAlignment,
  RecoveryScenarioPolicy,
  StrengthPhasePolicy,
} from "@stride/contract";

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
    quality_family: "M 配速专项为主，保留 T 长间歇（MP-10~20s 级）与间歇刺激维持 VO2max；跨周质量课结构不重复（课表库 #798）",
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
  let blockPendingCut = false;
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
    // recovery 不计入；跨阶段不重置——相位内计数会在短阶段漏排）。
    // 放位规则（#806 拍板①）：吸收距赛周 ≥ taper_weeks+1——吸收落在 taper 前一周
    // 时 taper 从平台位重算会反超吸收周（E2E 实测锯齿 63.8→70.1）；距赛不足则该
    // 周按常规建设周计，计数顺延。短跑道（≤8 周）整体禁用——减量弧本身即恢复。
    const buildSoFar = weeks.filter((x) => x.canonical !== "recovery" && (x.role === "progress" || x.role === "absorb")).length;
    const absorb =
      N > SHORT_ABSORB_MAX_WEEKS && !inTaper && p.canonical !== "recovery" && buildSoFar > 0 && (buildSoFar + 1) % ABSORB_EVERY === 0 && N - w >= taperW + 1;
    // 块边界（2026-11-09 用户评审拍板：吸收周归前块）：阶段首周开新块；吸收周
    // **不**开新块——它是前块（3 进展周）的收尾（超代偿单元完整 = daniels.md
    // §3.2「吸收周需整块连贯」），下一常规周才开新块。旧实现吸收周自增 blockId
    // 导致「块1=W1-W3 / 块2=吸收+1 进展 / 单周吸收块」的破碎形态（18 周实测
    // 7 块=3/2/2/1/3/1/6）；修正后=4/1/3/4/6（阶段尾单周碎片另由生成层合并）。
    if (phaseWeekIdx === 1) blockId++;
    else if (blockPendingCut) {
      blockId++;
      blockPendingCut = false;
    }
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
      // 夹取参照=削减深度门的 plateauRef 同款（FQ 非赛周最大 km，含 taper 周）
      const ref = Math.max(plateau, ...weeks.filter((x) => x.canonical === "final_quality" && x.role !== "race").map((x) => x.km));
      // 赛周=比赛里程+日常量 clamp(平台×0.25, 14, 28)（2026-11-01 原书口径）：
      // 减量曲线主体=不含比赛的日常量（丹尼尔斯 2Q 实证日常≈峰值 0.17-0.25×），
      // 含比赛总账是衍生物；低量档日常下限 14 保证每日 shake 有预算（#809 的
      // 「不得低于比赛里程」由公式形态天然保证）
      const raceDaily = Math.min(ACTIVATION_MAX_KM, Math.max(ACTIVATION_MIN_KM, plateau * RACE_DAILY_SHARE));
      km = isRace ? RACE_KM + raceDaily : plateau * (1 - (TAPER_CURVE * tIdx) / (taperW + 1));
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
    // 下限 min(12, km×cap)：低量周（km≲27）份额优先，运行下限不再硬顶破份额门。
    // taper 周独立削减（#809）：常规目标再被随深度递减的带上限修剪（首 taper 周 25、
    // 每深一周 −5；taperW≤3 不变量保证结果恒落 20-25 带，无需下限钳制）；
    // recovery 小 LR、赛周 null 不变。
    let lr: number | null;
    if (isRace) {
      lr = null;
    } else if (p.canonical === "recovery") {
      lr = r1(Math.min(14, km * 0.3));
    } else {
      const base = Math.max(Math.min(LR_MIN_KM, km * lrCap), lrTarget);
      lr = r1(role === "taper" ? Math.min(base, TAPER_LR_MAX_KM - 5 * (taperW - fromEnd - 1)) : base);
    }
    // 赛周 q=2（#825）：比赛课+赛前激活短课各算一节（规则③⑧维持原则）；taper 周
    // q=2（2026-11-01 丹尼尔斯原书口径校准）：倒数第二周仍 2Q 足量（原书 2Q 计划
    // W17 两节质量课合计约 17mi 阈值跑），减量从 E 里程里出而非砍质量课
    const q =
      p.canonical === "recovery"
        ? 0
        : isRace
          ? 2
          : inTaper
            ? km >= TAPER_Q2_MIN_KM
              ? 2
              : 1
            : p.canonical === "foundation"
              ? km >= Q_FOUNDATION_KM
                ? 1
                : 0
              : km >= Q_BUILD_KM
                ? 2
                : 1;
    weeks.push({ week: w, canonical: p.canonical, block: blockId, role, km: r1(km), lr, q });
    if (absorb) blockPendingCut = true;
  }

  // 块结构标记：按块聚合，记录 3+1 边界与吸收周；随后施加「块长 ≥2」不变式
  //（2026-11-09 用户拍板）：单周块并入**同阶段**相邻块——向前优先（阶段尾溢出
  // 周挂回本阶段），阶段首周单块则向后（如 final_quality 首周兼吸收）。跨阶段
  // 不并（块与阶段对齐：18 周=foundation 5/early 3/transition 4/final 6 四块
  // 对四阶段）；recovery 块豁免（独立低量平语义单独成批）。
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
  for (let i = 0; i < blocks.length; ) {
    const b = blocks[i]!;
    const prev = i > 0 ? blocks[i - 1]! : null;
    const next = i + 1 < blocks.length ? blocks[i + 1]! : null;
    // recovery 块豁免（独立语义：低量平单独成批，教义 §3.2）；吸收单周已有阶段
    // 语义豁免之外的普通单周才合并
    const mergeIntoPrev = prev != null && prev.canonical === b.canonical;
    const mergeIntoNext = next != null && next.canonical === b.canonical;
    if (b.end_week - b.start_week + 1 === 1 && blocks.length > 1 && b.canonical !== "recovery" && (mergeIntoPrev || mergeIntoNext)) {
      if (mergeIntoPrev) {
        prev!.end_week = b.end_week;
        prev!.absorb_weeks.push(...b.absorb_weeks);
      } else {
        next!.start_week = b.start_week;
        next!.absorb_weeks.unshift(...b.absorb_weeks);
        // 阶段首周单块向后并时继承 phase_start 边界（合并块起点=阶段首周）
        if (b.boundary === "phase_start") next!.boundary = "phase_start";
      }
      blocks.splice(i, 1);
    } else i++;
  }
  // 合并后按块序重编号，weeks[].block 与 blocks[].block 同步
  weeks.forEach((wk) => {
    const idx = blocks.findIndex((b) => wk.week >= b.start_week && wk.week <= b.end_week);
    if (idx >= 0) wk.block = blocks[idx]!.block;
  });
  blocks.forEach((b, idx) => {
    b.block = idx + 1;
  });
  weeks.forEach((wk) => {
    const idx = blocks.findIndex((b) => wk.week >= b.start_week && wk.week <= b.end_week);
    if (idx >= 0) wk.block = idx + 1;
  });

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
