import type { PhaseEvidence } from "./evidence.js";
import type { PhaseCanonical, PhaseDivisionIntent } from "./intent.js";
import { EXPECTED_BLOCK_MODE, MIN_PHASE_WEEKS, PHASE_ORDER } from "./intent.js";

/**
 * 确定性结构门（devops#782 D 节，daniels.md §2.3）：LLM 输出的终检。
 * 违规 → 带违规清单重试 ≤2 次 → 落 T 兜底（generate.ts 编排）。
 */

export interface GateCheck {
  id: string;
  pass: boolean;
  detail: string;
}

/** 里程碑/gate 可观察信号词表（I6/I7）。 */
const SIGNAL_KEYWORDS = [
  "km",
  "公里",
  "长跑",
  "long",
  "质量",
  "quality",
  "E 份额",
  "E份额",
  "HRV",
  "RPE",
  "体感",
  "feel",
  "CTL",
  "配速",
  "T ",
  "M ",
  "心率",
  "strides",
];
/** rationale 引证词表（I10）。 */
const EVIDENCE_KEYWORDS = ["km", "公里", "E 份额", "E份额", "Q", "质量", "PB", "CTL", "比赛", "马拉松", "配速", "长跑", "月", "份额", "strides"];

/** 数值容差：体量带比较留 0.5km 余量（LLM 整数输出 vs 浮点帽）。 */
const BAND_TOLERANCE_KM = 0.5;

const weeksOf = (p: PhaseDivisionIntent["phases"][number]) => p.end_week - p.start_week + 1;

/** phase 引用字符串（milestones/gates/volume_bands 的 phase 字段）与阶段匹配（宽松三子句，与 spike 同款）。 */
function phaseRefMatches(phase: { canonical: string; name: string }, ref: string): boolean {
  return ref.includes(phase.canonical) || ref === phase.name || phase.name.includes(ref);
}

/**
 * 峰值体量帽（I8，daniels.md 教义）：min(120, max(近8周×1.6, 近期峰值×1.3))。
 * 下限 30：零史/极低量跑者的帽不为 0——训练计划永远给（daniels.md §2.4），
 * 帽是护栏不是课表，0 帽会令任何合法体量带都无法通过 I8。
 */
export function peakVolumeCapKm(evidence: PhaseEvidence): number {
  const { avg_8wk_km, recent_peak_week_km } = evidence.recent_volume;
  return Math.max(30, Math.min(120, Math.max(avg_8wk_km * 1.6, recent_peak_week_km * 1.3)));
}

export function validatePhaseIntent(intent: PhaseDivisionIntent, runwayWeeks: number, evidence: PhaseEvidence): GateCheck[] {
  const checks: GateCheck[] = [];
  const phases = [...intent.phases].sort((a, b) => a.start_week - b.start_week);
  const names: PhaseCanonical[] = phases.map((p) => p.canonical);
  const N = runwayWeeks;

  // I1 闭合：周区间首尾相接且覆盖 1..N
  let cursor = 1;
  const gaps: string[] = [];
  for (const p of phases) {
    if (p.start_week !== cursor || p.end_week < p.start_week || p.end_week > N) gaps.push(`${p.canonical}:${p.start_week}-${p.end_week}(期望起${cursor})`);
    cursor = p.end_week + 1;
  }
  checks.push({ id: "I1 闭合", pass: gaps.length === 0 && cursor === N + 1, detail: gaps.join(";") || `1..${N} 连续` });

  // I2 顺序律：五值可坍缩不可倒置、canonical 不重复
  const uniq = new Set(names).size === names.length;
  const idx = PHASE_ORDER.map((n) => names.indexOf(n));
  const seqOk = idx.every((i, k) => i === -1 || idx.slice(0, k).every((j) => j === -1 || j < i));
  checks.push({ id: "I2 顺序律", pass: seqOk && uniq, detail: names.join("→") });

  // I3 赛后先恢复：距上场比赛 ≤14 天时首阶段必须是 recovery（N=1 退化跑道豁免：
  // 唯一一周给了 recovery 就没有 final_quality，两门数学互斥，意图退化为赛前微周期）
  const daysSince = evidence.last_race?.days_ago ?? 999;
  checks.push({
    id: "I3 赛后先恢复",
    pass: daysSince > 14 || N < 2 || names[0] === "recovery",
    detail: `距赛${daysSince}d 首${names[0] ?? "无"}`,
  });

  // I4 专项在场：final_quality 在场且 N≥16 时 ≥4 周、否则 ≥2 周（N=2 且赛后先恢复时只余 1 周，豁免为 ≥1）
  const fq = phases.find((p) => p.canonical === "final_quality");
  const fqW = fq ? weeksOf(fq) : 0;
  const fqMin = N <= 2 ? 1 : N >= 16 ? 4 : 2;
  checks.push({ id: "I4 专项在场", pass: !!fq && fqW >= fqMin, detail: fq ? `${fqW}w（需≥${fqMin}）` : "缺失" });

  // I5 taper 属性：不超 final_quality 周数（1-3 的值域由 IntentSchema 保证）
  checks.push({
    id: "I5 taper属性",
    pass: !!fq && intent.taper_weeks <= fqW,
    detail: `taper=${intent.taper_weeks}w 专项${fqW}w`,
  });

  // I6 里程碑：final_quality 之外每阶段 ≥1 条且绑可观察信号
  let missSignal = 0;
  const uncovered: string[] = [];
  for (const p of phases) {
    if (p.canonical === "final_quality") continue;
    const ms = intent.milestones.filter((m) => phaseRefMatches(p, m.phase));
    if (ms.length === 0) uncovered.push(p.canonical);
    if (ms.length > 0 && !ms.some((m) => SIGNAL_KEYWORDS.some((k) => m.signal.includes(k) || m.criterion.includes(k)))) missSignal++;
  }
  checks.push({
    id: "I6 里程碑",
    pass: uncovered.length === 0 && missSignal === 0,
    detail: uncovered.length ? `缺:${uncovered.join(",")}` : missSignal ? `${missSignal} 条无可观察信号` : "全覆盖",
  });

  // I7 阶段 gate：绑信号、含未达标动作（2-3 条的数量约束由 IntentSchema 保证）
  const gateOk = intent.gates.every((g) => SIGNAL_KEYWORDS.some((k) => g.signal.includes(k) || g.criterion.includes(k)) && g.action_if_missed.length > 3);
  checks.push({ id: "I7 阶段gate", pass: gateOk, detail: `${intent.gates.length} 条` });

  // I8 体量带：峰值帽 / recovery 帽 / 伤后 foundation 帽 / min≤max / 双向覆盖
  const peakCap = peakVolumeCapKm(evidence);
  const cap = peakCap + BAND_TOLERANCE_KM;
  let bandBad = "";
  const bandMaxAll = Math.max(0, ...intent.volume_bands.map((b) => b.weekly_km_max));
  if (bandMaxAll > cap) bandBad = `峰值带${bandMaxAll}>帽${peakCap.toFixed(1)} `;
  for (const p of phases) {
    if (!intent.volume_bands.some((b) => phaseRefMatches(p, b.phase))) bandBad += `${p.canonical} 缺体量带 `;
  }
  for (const b of intent.volume_bands) {
    if (b.weekly_km_min > b.weekly_km_max) bandBad += `${b.phase} min>max `;
    const p = phases.find((x) => phaseRefMatches(x, b.phase));
    if (!p) bandBad += `${b.phase} 无法对应阶段 `;
    else if (p.canonical === "recovery" && b.weekly_km_max > evidence.recent_volume.recent_peak_week_km * 0.6 + BAND_TOLERANCE_KM)
      bandBad += `recovery 带${b.weekly_km_max} `;
    else if (
      evidence.injury_return &&
      p.canonical === "foundation" &&
      b.weekly_km_max > evidence.injury_return.pre_injury_peak_week_km * 0.78 + BAND_TOLERANCE_KM
    )
      bandBad += `伤后foundation 带${b.weekly_km_max} `;
  }
  checks.push({ id: "I8 体量带", pass: bandBad === "", detail: bandBad || `峰值带${bandMaxAll}` });

  // I9 块模式一致：canonical → 期望块形状
  const modeDev = phases.filter((p) => p.block_mode !== EXPECTED_BLOCK_MODE[p.canonical]).map((p) => `${p.canonical}→${p.block_mode}`);
  checks.push({ id: "I9 块模式", pass: modeDev.length === 0, detail: modeDev.join(",") || "一致" });

  // I10 rationale 引证：每条 rationale 命中证据词表
  const noCite = phases.filter((p) => !EVIDENCE_KEYWORDS.some((k) => p.rationale.includes(k))).map((p) => p.canonical);
  checks.push({ id: "I10 rationale引证", pass: noCite.length === 0, detail: noCite.length ? noCite.join(",") : "全引证" });

  // I11 最小有效周期 + 短跑道形态门（N≤6 = final-only）
  if (N <= 6) {
    const badShape = phases.filter((p) => p.canonical !== "recovery" && p.canonical !== "final_quality");
    checks.push({
      id: "I11 final-only形态",
      pass: badShape.length === 0 && phases.length <= 2,
      detail: badShape.length ? `非法阶段:${badShape.map((p) => p.canonical).join(",")}` : `${phases.length} 阶段`,
    });
  } else {
    const tooShort = phases.filter((p) => weeksOf(p) < MIN_PHASE_WEEKS[p.canonical]).map((p) => `${p.canonical}${weeksOf(p)}w`);
    checks.push({ id: "I11 最小周期", pass: tooShort.length === 0, detail: tooShort.join(",") || "达标" });
  }

  return checks;
}

/** 违规清单文案（重试反馈 / 观测用）。 */
export function gateViolations(checks: readonly GateCheck[]): string[] {
  return checks.filter((c) => !c.pass).map((c) => `${c.id}：${c.detail}`);
}
