import type { PhaseDivisionIntent } from "../intent.js";
import { phaseRefMatches } from "../intent.js";
import type { LoadWeek } from "./expand.js";
import { bandOf } from "./reachability.js";

/**
 * 载荷层六条验收门（devops#793 E 节，daniels-l3-load.md §4，38 案例实测沉淀）：
 * 1 三硬门（ACWR≤1.3 / 单周尖峰 / 块对块） 2 带贴合（爬坡豁免） 3 节奏（3+1）
 * 4 LR（峰值/份额/赛周 null/期内单调） 5 taper（赛周区间/峰后弧单调/削减深度）
 * 6 块内微阶梯存在性。两个实测陷阱已内化：块豁免查带必须用真实阶段行；
 * taper 单调判据方向（削至赛周=递减）。
 */

export interface LoadCheck {
  id: string;
  pass: boolean;
  detail: string;
}

/** 数值容差（km）：ACWR/尖峰/带比较留余量（1 位小数舍入 vs 浮点构造）。 */
const TOLERANCE_KM = 0.5;
/** LR 期内单调容差：合法抖动=微阶梯回卷（6%）+60km 份额档切换，按 LR≤34 计 ≈2.3。 */
const LR_MONO_TOLERANCE_KM = 2.5;
/** LR 下限低量档分界：计划峰 <58km 时下限随峰值下调（≈峰×0.36）。 */
const LR_LOW_VOLUME_PEAK_KM = 58;
const LR_LOW_VOLUME_FLOOR_RATIO = 0.36;

const r1 = (x: number) => Math.round(x * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function validateLoad(intent: PhaseDivisionIntent, weeks: LoadWeek[], recentWeeksKm: number[]): LoadCheck[] {
  const checks: LoadCheck[] = [];
  const km = weeks.map((w) => w.km);
  const actual4 = recentWeeksKm.slice(-4);
  const phases = [...intent.phases].sort((a, b) => a.start_week - b.start_week);
  const phaseAt = (w: number) => phases.find((p) => p.start_week <= w && w <= p.end_week) ?? phases.at(-1)!;

  // 门 1a/1b：ACWR ≤1.3 与单周尖峰 ≤1.5×4 周均值（滚动含赛前实际周）
  const roll4 = (i: number) => [...actual4, ...km.slice(0, i)].slice(-4);
  const acwrBad: number[] = [];
  const spikeBad: number[] = [];
  for (let i = 0; i < km.length; i++) {
    const m = mean(roll4(i));
    if (km[i]! > 1.3 * m + TOLERANCE_KM) acwrBad.push(i + 1);
    if (km[i]! > 1.5 * m + TOLERANCE_KM) spikeBad.push(i + 1);
  }
  checks.push({ id: "H1 ACWR≤1.3", pass: acwrBad.length === 0, detail: acwrBad.length ? `W${acwrBad.join(",")} 超限` : "全过" });
  checks.push({ id: "H2 单周尖峰≤1.5×滚动均值", pass: spikeBad.length === 0, detail: spikeBad.length ? `W${spikeBad.join(",")} 超限` : "全过" });

  // 门 1c：块对块 ≤+25%（块均值；吸收周除外、不跨 recovery 边界——卸载回弹归
  // ACWR 管；豁免「跨阶段进更高带」段——查带必须用真实阶段行，canonical 假行
  // 永远匹配不上中文显示名引用，spike 实测陷阱）
  const blocks = new Map<number, LoadWeek[]>();
  const recoveryBlocks = new Set(weeks.filter((w) => w.canonical === "recovery").map((w) => w.block));
  for (const w of weeks) {
    if ((w.role === "progress" || w.role === "taper") && !recoveryBlocks.has(w.block)) blocks.set(w.block, [...(blocks.get(w.block) ?? []), w]);
  }
  const blockIds = [...blocks.keys()].sort((a, b) => a - b);
  const means = blockIds.map((id) => mean(blocks.get(id)!.map((w) => w.km)));
  const blockCanonical = new Map<number, string>();
  for (const id of blockIds) blockCanonical.set(id, blocks.get(id)![0]!.canonical);
  const blockBad: string[] = [];
  for (let i = 1; i < blockIds.length; i++) {
    const pa = blockCanonical.get(blockIds[i - 1]!)!;
    const pb = blockCanonical.get(blockIds[i]!)!;
    const phaseB = phases.find((x) => x.canonical === pb);
    const bandB = phaseB ? bandOf(intent, phaseB) : null;
    const enteringHigherBand = pa !== pb && bandB != null && means[i - 1]! < bandB.weekly_km_min - 2;
    if (means[i]! > means[i - 1]! * 1.25 + 2 && !enteringHigherBand) blockBad.push(`${i}→${i + 1}(${r1(means[i - 1]!)}→${r1(means[i]!)})`);
  }
  checks.push({ id: "H3 块对块≤+25%", pass: blockBad.length === 0, detail: blockBad.join(";") || "全过" });

  // 门 2：带贴合——建设周（progress）落带内；爬坡期豁免（低于 lo 但逐周递增、
  // 或被 ACWR 帽压制，两种合法形态）；taper/吸收周豁免（带管建设周）
  const outBand: string[] = [];
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i]!;
    if (w.role !== "progress") continue;
    const phase = phaseAt(w.week);
    const band = bandOf(intent, phase);
    if (!band) continue;
    const rollMean = mean([...actual4, ...km.slice(0, i)].slice(-4));
    const capSuppressed = w.km <= 1.3 * rollMean + TOLERANCE_KM;
    const rampingIn = i > 0 && w.km >= km[i - 1]! - TOLERANCE_KM;
    if (w.km > band.weekly_km_max + 2 || (w.km < band.weekly_km_min - 2 && !rampingIn && !capSuppressed)) {
      outBand.push(`W${w.week}=${w.km}(${band.weekly_km_min}-${band.weekly_km_max})`);
    }
  }
  checks.push({ id: "L1 带贴合", pass: outBand.length === 0, detail: outBand.slice(0, 4).join(";") || "全过" });

  // 门 3：节奏——建设周 ≥8 才要求 3+1 吸收周；短跑道/final-only 豁免。
  // 建设计数与展开器同口径（recovery 不计入），否则 rec2+F5 布局会被误判欠吸收
  const build = weeks.filter((w) => w.role === "progress" && w.canonical !== "recovery").length;
  const absorbs = weeks.filter((w) => w.role === "absorb").length;
  const rhythmNeeded = build >= 8;
  checks.push({
    id: "L2 节奏3+1",
    pass: !rhythmNeeded || absorbs >= Math.floor(build / 4),
    detail: rhythmNeeded ? `${absorbs}吸收/${build}建设` : `${build} 建设周（豁免）`,
  });

  // 门 4：LR——峰值区间（低量档随计划峰下调）、份额、赛周 null、期内单调
  // （形式化=相位出口 LR 处于相位内峰值：阶段内递进无倒挂；相位起点的
  // ACWR washout 凹陷是帽强制的合法形态，不算倒挂；阶梯抖动容忍 2.5km）
  const peak = Math.max(...km);
  const lrs = weeks.filter((w) => w.lr != null && w.role !== "taper" && w.role !== "race");
  const lrMax = Math.max(0, ...lrs.map((w) => w.lr ?? 0));
  const shareOk = lrs.every((w) => (w.lr ?? 0) <= w.km * (w.km < 60 ? 0.42 : 0.36) + TOLERANCE_KM);
  const lrFloor = peak >= LR_LOW_VOLUME_PEAK_KM ? 22 : peak * LR_LOW_VOLUME_FLOOR_RATIO;
  const monoOk = (() => {
    let seg: number[] = [];
    let prevCanonical = "";
    for (const w of weeks) {
      if (w.role !== "progress" || w.canonical === "recovery" || w.lr == null) continue;
      if (w.canonical !== prevCanonical) {
        if (seg.length >= 2 && Math.max(...seg) - seg.at(-1)! > LR_MONO_TOLERANCE_KM) return false;
        seg = [];
        prevCanonical = w.canonical;
      }
      seg.push(w.lr);
    }
    return !(seg.length >= 2 && Math.max(...seg) - seg.at(-1)! > LR_MONO_TOLERANCE_KM);
  })();
  checks.push({
    id: "L3 LR曲线",
    pass: lrMax >= lrFloor - TOLERANCE_KM && lrMax <= 34 && shareOk && weeks.at(-1)?.lr == null && monoOk,
    detail: `峰${lrMax}/下限${r1(lrFloor)} 份额${shareOk ? "✓" : "✗"} 单调${monoOk ? "✓" : "✗"}`,
  });

  // 门 5：taper——赛周 0.35-0.72×峰、峰后弧单调、削减深度 30-50%。
  // 峰后弧单调（#806，原「taper 段单调降」扩展）：末段平台顶（最后一个
  // final_quality progress 周）起至赛周单调不升——吸收落进弧内被 taper 平台位
  // 重算反超的锯齿在此判；中段吸收-回弹（峰值再临）在弧外，3+1 节奏合法。
  // 无平台参照的全程 taper 布局退回 taper 段内单调。削减深度（平台参照=
  // final_quality 非赛周最大 km；N=1 单周跑道与无平台参照的衰退跑道豁免子判据
  // ——赛周即全计划，无 taper 结构可验）
  const raceKm = km.at(-1)!;
  const arcStart = weeks.findLastIndex((w) => w.canonical === "final_quality" && w.role === "progress");
  const taperKms = weeks.filter((w) => w.role === "taper").map((w) => w.km);
  const monoDown =
    arcStart >= 0
      ? weeks.slice(arcStart).every((x, i, arr) => i === 0 || x.km <= arr[i - 1]!.km + TOLERANCE_KM)
      : taperKms.every((x, i) => i === 0 || x <= taperKms[i - 1]! + TOLERANCE_KM);
  const plateauRef = Math.max(0, ...weeks.filter((w) => w.canonical === "final_quality" && w.role !== "race").map((w) => w.km));
  const singleWeek = weeks.length < 2;
  const cutDepthOk = singleWeek || plateauRef <= 0 || (raceKm >= plateauRef * 0.5 - TOLERANCE_KM && raceKm <= plateauRef * 0.7 + TOLERANCE_KM);
  const bandOk = singleWeek || (raceKm <= peak * 0.72 && raceKm >= peak * 0.35);
  checks.push({
    id: "L4 taper",
    pass: bandOk && monoDown && cutDepthOk,
    detail: singleWeek
      ? "单周跑道豁免"
      : `赛周${raceKm}/峰${r1(peak)}=${r1(raceKm / peak)} 弧单调${monoDown ? "✓" : "✗"} 削减${plateauRef > 0 ? r1((1 - raceKm / plateauRef) * 100) : "?"}%`,
  });

  // 门 6：块内微阶梯存在性——至少一块 ≥3 个建设周呈 0.97/1/1.03 微递进
  // （非平台直排；全帽压制/短跑道无 3 周块时豁免）
  const stairBlocks = [...blocks.values()].filter((ws) => ws.filter((w) => w.role === "progress").length >= 3);
  const stairOk =
    stairBlocks.length === 0 ||
    stairBlocks.some((ws) => {
      const xs = ws.filter((w) => w.role === "progress").map((w) => w.km);
      return Math.max(...xs) - Math.min(...xs) >= TOLERANCE_KM;
    });
  checks.push({ id: "L5 块内微阶梯", pass: stairOk, detail: stairBlocks.length === 0 ? "无 ≥3 周块（豁免）" : stairOk ? "存在" : "全平台直排" });

  return checks;
}
