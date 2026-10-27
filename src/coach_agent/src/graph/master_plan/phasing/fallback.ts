import type { PhaseEvidence } from "./evidence.js";
import { peakVolumeCapKm } from "./gates.js";
import type { PhaseCanonical, PhaseDivisionIntent } from "./intent.js";
import { DEFAULT_PRIMARY_GOAL, EXPECTED_BLOCK_MODE, MIN_PHASE_WEEKS, PHASE_DISPLAY_NAME, PhaseDivisionIntentSchema } from "./intent.js";

/**
 * T 表兜底（devops#782 E 节，#732 终调和的落地形态）：确定性跑道查表 + 学分调整，
 * 产出同 IntentSchema 的合法意图。定位=结构缺省 + 包络校验 + LLM 失败兜底，
 * 不拿走判断（daniels.md §2.3）。
 */

type PhaseWeeks = { canonical: PhaseCanonical; weeks: number };

const f = (canonical: PhaseCanonical, weeks: number): PhaseWeeks => ({ canonical, weeks });

/**
 * 主跑道查表（daniels.md §2.4 坍缩阶梯的确定性缺省；各档已满足 I11 下限，
 * 7-9 周档先砍 early_quality）。recovery 不占查表预算：14 天内完赛时从跑道头
 * 切 1 周前置，余下按 effectiveN 查表。
 */
function baseLayout(effectiveN: number): PhaseWeeks[] {
  if (effectiveN >= 23) return [f("foundation", 6), f("early_quality", 3), f("transition_quality", 6), f("final_quality", 8)];
  if (effectiveN >= 20) return [f("foundation", 5), f("early_quality", 3), f("transition_quality", 5), f("final_quality", 7)];
  if (effectiveN >= 17) return [f("foundation", 4), f("early_quality", 2), f("transition_quality", 5), f("final_quality", 6)];
  if (effectiveN >= 14) return [f("foundation", 4), f("early_quality", 2), f("transition_quality", 4), f("final_quality", 4)];
  if (effectiveN >= 12) return [f("foundation", 4), f("early_quality", 2), f("transition_quality", 3), f("final_quality", 3)];
  if (effectiveN >= 10) return [f("foundation", 3), f("early_quality", 2), f("transition_quality", 2), f("final_quality", 3)];
  if (effectiveN === 9) return [f("foundation", 3), f("transition_quality", 3), f("final_quality", 3)];
  if (effectiveN >= 7) return [f("foundation", 2), f("transition_quality", 2), f("final_quality", 3)];
  // ≤6 周：final-only 形态（I11 形态门），final_quality 承载全部周数
  return [f("final_quality", effectiveN)];
}

/** 学分调整（证据驱动的确定性规则，daniels.md §2.3 设计场景的缺省实现）。 */
function applyCredits(layout: PhaseWeeks[], evidence: PhaseEvidence, N: number): void {
  const credit = evidence.phase_credit;
  const seg = (c: PhaseCanonical) => layout.find((p) => p.canonical === c);
  // 有氧学分足 → foundation 砍半（仅当 ≥4 周，保底 2），省的周给 final_quality
  if (credit.sustained_volume_months_ge40wk >= 4 && credit.months_with_long_run_ge25 >= 3) {
    const segF = seg("foundation");
    if (segF && segF.weeks >= 4) {
      const cut = Math.floor(segF.weeks / 2);
      segF.weeks -= cut;
      const segQ = seg("final_quality");
      if (segQ) segQ.weeks += cut;
    }
  }
  // 质量学分 → early_quality -1（仅当 >2 周），给 transition_quality
  if (credit.months_with_ge4_quality >= 3 && N >= 12) {
    const segE = seg("early_quality");
    if (segE && segE.weeks > MIN_PHASE_WEEKS.early_quality) {
      segE.weeks -= 1;
      const segT = seg("transition_quality");
      if (segT) segT.weeks += 1;
    }
  }
  // 伤退 → foundation 拉长 +2、transition_quality 让渡（保底 2）
  if (evidence.injury_return) {
    const segF = seg("foundation");
    const segT = seg("transition_quality");
    if (segF) segF.weeks += 2;
    if (segT && segT.weeks > MIN_PHASE_WEEKS.transition_quality) segT.weeks -= Math.min(2, segT.weeks - MIN_PHASE_WEEKS.transition_quality);
  }
}

/**
 * 周数闭合（超支时）：按坍缩阶梯的让渡次序收敛到 N——
 * 1) final_quality 砍到下限（N>6 需 ≥3，N≤6 final-only 可收到 1）
 * 2) transition_quality / early_quality 各砍到 2
 * 3) 仍超支 → 移除 early_quality，再移除 transition_quality（阶梯「先砍 early 再砍 transition」；
 *    如 N=7 赛后：r1+F2+T2+FQ3=8 放不下，唯一合法形态是去掉 transition）
 * 4) 结余（不足 N）→ 全给 foundation（FM 特化允许基础期更长）。
 */
function closeToRunway(layout: PhaseWeeks[], N: number): PhaseWeeks[] {
  const floorOf = (canonical: PhaseCanonical): number =>
    canonical === "final_quality" ? (N <= 6 ? 1 : MIN_PHASE_WEEKS.final_quality) : canonical === "recovery" ? 1 : 2;
  const sum = () => layout.reduce((s, p) => s + p.weeks, 0);
  for (const canonical of ["final_quality", "transition_quality", "early_quality"] as const) {
    while (sum() > N) {
      const seg = layout.find((p) => p.canonical === canonical);
      if (!seg || seg.weeks <= floorOf(canonical)) break;
      seg.weeks -= 1;
    }
  }
  for (const canonical of ["early_quality", "transition_quality"] as const) {
    if (sum() > N) {
      const idx = layout.findIndex((p) => p.canonical === canonical);
      if (idx >= 0) layout.splice(idx, 1);
    }
  }
  const base = layout.find((p) => p.canonical === "foundation");
  if (base && sum() !== N) base.weeks = Math.max(MIN_PHASE_WEEKS.foundation, base.weeks + N - sum());
  return layout.filter((p) => p.weeks > 0);
}

/**
 * 峰值爬坡系数（按建设周数，三档）：N 周内安全可增体量随建设周数缩放——
 * 短跑道（≤6 周）+25%、中跑道（7-9 周）+30%、长跑道（≥10 周）+55%。
 * 中跑道另有判断层实证停位项（帽×0.88，见 conservativePeakAnchor）。
 */
function peakRampFactor(buildWeeks: number): number {
  if (buildWeeks <= 6) return 1.25;
  if (buildWeeks <= 9) return 1.3;
  return 1.55;
}

/**
 * 保守峰值锚（#810）：min(帽, max(habitual×1.25, avg8×爬坡, 中跑道帽停位))，
 * 伤退再夹伤前峰值 75%，帽触 30 护栏时锚骑护栏——帽是上限不是目标，兜底
 * 不得坐顶；兜底产物须与判断层保守判断同档（回放验收=兜底 vs 判断层峰值
 * 中位带差 ≤15%）。
 * 三项各自锚定判断层的一种保守停法（基线校准=#810 回放 12 切片×4 轮，
 * 0.15 温判断层峰值中位）：habitual 增长下限、avg8 增长（长短跑道主导项，
 * 判断层中位≈avg8×1.25/×1.55）、中跑道停位（判断层在帽 88% 位停车：
 * chaoyi 0.875/dingchentao 0.85/pan 0.89——avg8 乘数此时按运动员分化
 * ×1.2-1.6 无常数可覆盖，帽位反而三人一致）。判断层同切片抽样噪声
 * ±10-15%，回放门按多抽样中位判（phasingReplay.ts）。
 */
function conservativePeakAnchor(evidence: PhaseEvidence, buildWeeks: number): number {
  const peakCap = peakVolumeCapKm(evidence);
  const midRunwayCapShare = buildWeeks > 6 && buildWeeks <= 9 ? 0.88 : 0;
  let anchor = Math.min(
    peakCap,
    Math.max(evidence.habitual.week_km * 1.25, evidence.recent_volume.avg_8wk_km * peakRampFactor(buildWeeks), peakCap * midRunwayCapShare),
  );
  // 伤退：低温下判断层把「起量≤伤前 60-70%」读进峰值（回放实证 0.15 温
  // injury 峰=伤前 64-81%），锚同口径夹持；75% 取宽松端留判断层空间
  if (evidence.injury_return) anchor = Math.min(anchor, evidence.injury_return.pre_injury_peak_week_km * 0.75);
  // 零史/极低量跑者：锚骑峰值帽 30 护栏（gates.ts「计划永远给」——锚无下限
  // 会让兜底峰值塌到 habitual×1.25≈12，恰是 flash 最易落兜底的人群）
  return Math.max(anchor, Math.min(peakCap, 30));
}

/**
 * 体量带构造（#810 保守档对齐）：峰值锚见 conservativePeakAnchor；各阶段
 * 带按锚的 85/90/95/100% 保守系数排成不降阶梯（一律 ≤ 锚，证据下限只抬升
 * 不越锚），lo>hi 时收敛为 lo。
 */
function volumeBands(layout: PhaseWeeks[], evidence: PhaseEvidence, buildWeeks: number): PhaseDivisionIntent["volume_bands"] {
  const { avg_8wk_km, avg_4wk_km, recent_peak_week_km } = evidence.recent_volume;
  const peakCap = peakVolumeCapKm(evidence);
  const peakAnchor = conservativePeakAnchor(evidence, buildWeeks);
  const band = (phase: string, lo: number, hi: number) => {
    // hi 用 floor 且先与峰值帽取小：四舍五入的进位会越过 I8 帽（58.5→59 / 120→125）；
    // 低量跑者的 lo 也不硬压 8（recovery 帽可低至 18km），只保证 1≤lo≤hi
    const h = Math.max(1, Math.min(Math.floor(hi), Math.floor(peakCap)));
    const l = Math.min(Math.max(1, Math.round(lo)), h);
    return { phase, weekly_km_min: l, weekly_km_max: h };
  };
  // 阶梯 hi：锚分位与证据下限、前段 hi 三者取大再夹锚——保证 hi 不降且全表 ≤ 锚
  // （证据下限高于锚分位时只抬到 hi 本身，不会把带顶推过计划峰值）
  const ladderHi = (fraction: number, lo: number, prevHi: number) => Math.min(peakAnchor, Math.max(peakAnchor * fraction, lo, prevHi));
  let prevHi = 0;
  const out: PhaseDivisionIntent["volume_bands"] = [];
  for (const { canonical } of layout) {
    if (canonical === "recovery") out.push(band("recovery", recent_peak_week_km * 0.3, recent_peak_week_km * 0.55));
    else if (canonical === "foundation") {
      const lo = Math.max(avg_4wk_km * 0.9, 15);
      // 伤后另夹伤前峰值 70%（I8 伤后门），与阶梯 hi 取小
      const hi = evidence.injury_return
        ? Math.min(evidence.injury_return.pre_injury_peak_week_km * 0.7, ladderHi(0.85, lo, prevHi))
        : ladderHi(0.85, lo, prevHi);
      out.push(band("foundation", lo, hi));
      prevHi = hi;
    } else if (canonical === "early_quality") {
      const lo = avg_4wk_km;
      const hi = ladderHi(0.9, lo, prevHi);
      out.push(band("early_quality", lo, hi));
      prevHi = hi;
    } else if (canonical === "transition_quality") {
      const lo = avg_8wk_km * 1.1;
      const hi = ladderHi(0.95, lo, prevHi);
      out.push(band("transition_quality", lo, hi));
      prevHi = hi;
    } else out.push(band("final_quality", Math.max(avg_8wk_km * 1.1, evidence.habitual.week_km), peakAnchor));
  }
  return out;
}

function milestonesFor(layout: PhaseWeeks[], evidence: PhaseEvidence): PhaseDivisionIntent["milestones"] {
  const out: PhaseDivisionIntent["milestones"] = [];
  const push = (phase: string, signal: string, criterion: string) => out.push({ phase, signal, criterion });
  for (const { canonical } of layout) {
    if (canonical === "recovery") push("recovery", "HRV", "HRV 回基线 ±5%、无残留酸痛、主观疲劳 ≤3");
    else if (canonical === "foundation")
      push("foundation", "long_run_km", `长跑达到 ${Math.min(25, Math.max(20, Math.round(evidence.recent_volume.longest_run_8wk_km)))}km 连续两周完成无不适`);
    else if (canonical === "early_quality") push("early_quality", "质量课计数", "R 重复课连续 2 周完成且课后 24h 体感 ≤5");
    else if (canonical === "transition_quality") push("transition_quality", "T 配速课完成度", "2 节 T 课 48h 内恢复（体感 ≤5）");
    else push("final_quality", "M 配速课", "M 配速 30km 长距离按计划完成（比赛彩排）");
  }
  return out;
}

function fallbackGates(layout: PhaseWeeks[]): PhaseDivisionIntent["gates"] {
  const has = (c: PhaseCanonical) => layout.some((p) => p.canonical === c);
  const out: PhaseDivisionIntent["gates"] = [];
  if (has("recovery"))
    out.push({ phase: "recovery", signal: "HRV", criterion: "HRV 回基线 ±5%、主观疲劳 ≤3", action_if_missed: "延长恢复 3-5 天，保持纯 E 跑" });
  if (has("foundation"))
    out.push({ phase: "foundation", signal: "weekly_km", criterion: "周量连续 2 周达体量带下限", action_if_missed: "延长 foundation 一周，长跑回退 2km" });
  if (has("transition_quality"))
    out.push({ phase: "transition_quality", signal: "体感 RPE", criterion: "质量课后 48h 体感 ≤6", action_if_missed: "重复上一块块位，质量课减一节" });
  if (has("final_quality"))
    out.push({ phase: "final_quality", signal: "M 配速课完成度", criterion: "M 配速长距离按计划完成", action_if_missed: "下调峰值位、提前一周进入减量" });
  while (out.length < 2)
    out.push({ phase: "final_quality", signal: "weekly_km", criterion: "周量连续两周低于体量带下限 80%", action_if_missed: "下调块位并延长当前阶段一周" });
  return out.slice(0, 3);
}

function rationaleFor(canonical: PhaseCanonical, weeks: number, taperWeeks: number, evidence: PhaseEvidence): string {
  const { avg_8wk_km } = evidence.recent_volume;
  switch (canonical) {
    case "recovery":
      return `距上场比赛 ${evidence.last_race?.days_ago ?? "?"} 天（≤14 天），先卸疲劳：纯 E 跑 ${weeks} 周，周量 ≤ 近期峰值的 60%`;
    case "foundation":
      return `近 8 周均值 ${avg_8wk_km}km/周、月度有氧学分 ${evidence.phase_credit.sustained_volume_months_ge40wk} 个月 ≥40km/周，基础期 ${weeks} 周打底有氧与防伤`;
    case "early_quality":
      return `月度质量课学分 ${evidence.phase_credit.months_with_ge4_quality} 个月 ≥4 节，R 期 ${weeks} 周维持跑姿经济性与速度触感`;
    case "transition_quality":
      return `CTL ${evidence.fitness.ctl}，I/T 期 ${weeks} 周抬强度（I 保守、T 上量），衔接专项`;
    case "final_quality":
      return `目标 ${evidence.target.target_time}（${evidence.target.goal_pace}），专项期 ${weeks} 周含 taper ${taperWeeks} 周，M 配速长距离为主`;
  }
}

const TRAINING_GOAL: Record<PhaseCanonical, string> = {
  recovery: "卸疲劳、回基线，不引入强度刺激",
  foundation: "有氧量与长距离地基，E 跑为主配 strides 触感",
  early_quality: "R 重复跑建立跑姿经济性与速度",
  transition_quality: "I 间歇抬 VO2max、T 开始上量",
  final_quality: "M 配速长距离比赛专项，末段减量兑现",
};

/**
 * T 表兜底入口：LLM 失败/违规重试耗尽时调用；构造保证通过全部结构门
 * （fallback.test.ts 对 N=1..26 × 常态/伤后/赛后三场景做性质验证）。
 */
export function tableFallback(evidence: PhaseEvidence, runwayWeeks: number): PhaseDivisionIntent {
  const N = runwayWeeks;
  const racedRecently = (evidence.last_race?.days_ago ?? 999) <= 14 && N >= 2;
  // N≥7 按总跑道判档：7-9 周档的 foundation≥2 底线不因 recovery 前置被挤掉
  // （daniels.md §2.4「foundation≥2 与 final_quality≥3 底线不可再砍」）；超支的
  // 1 周由 closeToRunway 从尾段收割。N≤6 走 final-only 档，recovery 直接占预算。
  const effectiveN = racedRecently ? (N >= 7 ? N : N - 1) : N;
  let layout = baseLayout(effectiveN);
  if (racedRecently) layout = [f("recovery", 1), ...layout];
  applyCredits(layout, evidence, N);
  layout = closeToRunway(layout, N);

  const fqWeeks = layout.find((p) => p.canonical === "final_quality")?.weeks ?? 0;
  const taperWeeks = fqWeeks >= 6 ? 3 : fqWeeks >= 2 ? 2 : 1;

  const phases: PhaseDivisionIntent["phases"] = [];
  let week = 1;
  for (const { canonical, weeks } of layout) {
    phases.push({
      canonical,
      name: PHASE_DISPLAY_NAME[canonical],
      start_week: week,
      end_week: week + weeks - 1,
      primary_goal: DEFAULT_PRIMARY_GOAL[canonical],
      training_goal: TRAINING_GOAL[canonical],
      block_mode: EXPECTED_BLOCK_MODE[canonical],
      rationale: rationaleFor(canonical, weeks, taperWeeks, evidence),
    });
    week += weeks;
  }

  return PhaseDivisionIntentSchema.parse({
    phases,
    taper_weeks: taperWeeks,
    milestones: milestonesFor(layout, evidence),
    gates: fallbackGates(layout),
    // 爬坡按建设周数（effectiveN）取档：赛后 recovery 前置不占爬坡预算
    volume_bands: volumeBands(layout, evidence, effectiveN),
  });
}
