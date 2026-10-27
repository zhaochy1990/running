/**
 * 阶段划分意图层·真模型回放（devops#782 F 节验收，#810 扩观测）：
 * 三运动员 fixture × 场景 {22, 9, 5, injury}，走生产判断层链路
 * （deepseek-flash 低温 → 结构门 → 违规重试 ≤2 → T 兜底），每切片重复
 * REPLAY_REPEATS 次（默认 3）取判断层峰值中位——flash 同切片抽样噪声
 * ±10-15%，单抽样门会偶发越窗（4 轮实证：chaoyi/9 抽过 110/110/118），
 * 中位才是「判断层峰值档」的稳健估计。
 *
 * 烧 token，不进 CI（门禁层零 token）；本地验收用：
 *   DEEPSEEK_API_KEY=... npm run replay:phasing                    # 36 次调用
 *   REPLAY_REPEATS=1 DEEPSEEK_API_KEY=... npm run replay:phasing   # 快速冒烟
 * 过门率基线：flash 首版 15 切片 14 绿（spike 第六轮+v2 轮），本链路含重试。
 * #810 追加断言：兜底与判断层峰值中位带差 ≤15%（兜底≠变档的量化验收），
 * 并输出兜底率/首过率基线（兜底率生产观测=generate.ts outcome 日志，Grafana 面板另票）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAgentConfig, loadConfig, type ModelConfig } from "../config/config.js";
import type { PhaseEvidence } from "../graph/master_plan/phasing/evidence.js";
import { tableFallback } from "../graph/master_plan/phasing/fallback.js";
import { AS_OF, ATHLETES, type AthleteName, applyInjuryScenario, buildAthleteEvidence } from "../graph/master_plan/phasing/fixtureLoader.js";
import { createPhasingModel, generatePhaseDivisionIntent } from "../graph/master_plan/phasing/generate.js";

const OUT_DIR = resolve(import.meta.dirname, "../../test-output/phasing-replay");
const SCENARIOS = (process.env.REPLAY_SCENARIOS ?? "22,9,5,injury").split(",");
const RUNWAY_OF: Record<string, number> = { injury: 22 };
/** 每切片判断层重复调用次数（中位门的抽样数）。 */
const REPEATS = Math.max(1, Number(process.env.REPLAY_REPEATS ?? "3"));
/** #810 验收线：兜底 vs 判断层峰值中位带差。 */
const PEAK_ALIGN_TOLERANCE = 0.15;

function loadModel(): ModelConfig {
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  const config = loadConfig({ configFiles: [resolve(repoRoot, "config/coach.prod.yaml")] });
  return getAgentConfig(config, "phasing");
}

const raceDateOf = (weeks: number) => new Date(new Date(`${AS_OF}T00:00:00Z`).getTime() + (7 * weeks - 1) * 86400_000).toISOString().slice(0, 10);

const peakKmOf = (intent: { volume_bands: Array<{ weekly_km_max: number }> }) => Math.max(...intent.volume_bands.map((b) => b.weekly_km_max));

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};

interface CallRow {
  athlete: string;
  scenario: string;
  source: string;
  attempts: number;
  green: boolean;
  fails: string[];
  ms: number;
  llmPeakKm: number | null;
  fallbackPeakKm: number;
}

interface SliceRow {
  athlete: string;
  scenario: string;
  drawsPeakKm: number[];
  medianPeakKm: number | null;
  fallbackPeakKm: number;
  peakDiffPct: number | null;
  layout: string;
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("缺 DEEPSEEK_API_KEY（真模型回放烧 token，不进 CI）");
    process.exit(1);
  }
  const model = createPhasingModel(loadModel());
  await mkdir(OUT_DIR, { recursive: true });
  const calls: CallRow[] = [];
  const slices: SliceRow[] = [];

  for (const athlete of Object.keys(ATHLETES) as AthleteName[]) {
    const baseEvidence = await buildAthleteEvidence(athlete);
    for (const scenario of SCENARIOS) {
      const N = RUNWAY_OF[scenario] ?? Number(scenario);
      const evidence: PhaseEvidence = scenario === "injury" ? applyInjuryScenario(baseEvidence) : baseEvidence;
      // 兜底同证据同跑道现算（零 token）：与判断层终产物对比峰值档
      const fallbackPeakKm = peakKmOf(tableFallback(evidence, N));
      const draws: number[] = [];
      let last: Awaited<ReturnType<typeof generatePhaseDivisionIntent>> | null = null;
      const sliceCalls: CallRow[] = [];
      for (let i = 0; i < REPEATS; i++) {
        const t0 = Date.now();
        const outcome = await generatePhaseDivisionIntent({ evidence, runwayWeeks: N, raceDate: raceDateOf(N) }, model);
        last = outcome;
        // source=fallback 时 outcome.checks 是兜底自身的门（构造保证全绿），
        // 观测口径另算：判断层最终产物是否可用（source=llm）+ 兜底率
        const fails = outcome.checks.filter((c) => !c.pass).map((c) => c.id);
        const llmPeakKm = outcome.source === "llm" ? peakKmOf(outcome.intent) : null;
        if (llmPeakKm != null) draws.push(llmPeakKm);
        const row: CallRow = {
          athlete,
          scenario,
          source: outcome.source,
          attempts: outcome.attempts,
          green: outcome.source === "llm" && fails.length === 0,
          fails,
          ms: Date.now() - t0,
          llmPeakKm,
          fallbackPeakKm,
        };
        calls.push(row);
        sliceCalls.push(row);
      }
      const medianPeakKm = draws.length > 0 ? median(draws) : null;
      const peakDiffPct = medianPeakKm != null ? Math.abs(medianPeakKm - fallbackPeakKm) / medianPeakKm : null;
      const layout = last
        ? [...last.intent.phases]
            .sort((a, b) => a.start_week - b.start_week)
            .map((p) => `${p.canonical.replace("_quality", "Q").replace("foundation", "F")}${p.end_week - p.start_week + 1}`)
            .join("+")
        : "";
      const slice: SliceRow = { athlete, scenario, drawsPeakKm: draws, medianPeakKm, fallbackPeakKm, peakDiffPct, layout };
      slices.push(slice);
      const greenCalls = sliceCalls.filter((c) => c.green).length;
      const peakNote =
        peakDiffPct != null
          ? ` 抽[${draws.join("/")}]中位${medianPeakKm}/兜${fallbackPeakKm}(${(peakDiffPct * 100).toFixed(0)}%)`
          : ` 兜${fallbackPeakKm}(全落兜底)`;
      console.log(`  ${athlete}/${scenario} [${layout}] ${greenCalls}/${REPEATS} 绿${peakNote}`);
      if (last) {
        await writeFile(
          resolve(OUT_DIR, `phasing-${athlete}-${scenario}.json`),
          JSON.stringify({ ...slice, calls: sliceCalls, intent: last.intent, checks: last.checks }, null, 1),
        );
      }
    }
  }

  const green = calls.filter((c) => c.green).length;
  const fallback = calls.filter((c) => c.source === "fallback").length;
  const firstPass = calls.filter((c) => c.attempts === 1).length;
  console.log(
    `\n回放汇总（${REPEATS} 抽/切片）：${green}/${calls.length} 判断层全绿；兜底率 ${(fallback / calls.length) * 100}%（${fallback} 次）；首过率 ${(firstPass / calls.length) * 100}%`,
  );
  const notGreen = calls.filter((c) => !c.green);
  if (notGreen.length > 0) {
    console.log("未全绿调用：", notGreen.map((c) => `${c.athlete}/${c.scenario}#${c.attempts}(${c.fails.join("/") || "fallback"})`).join(" "));
  }
  // #810 量化验收：判断层峰值中位（source=llm 的抽样）与兜底峰值同档（≤15%）。
  // 全落兜底的切片没有独立判断层产物，不参与对比；injury 是回放专用的合成
  // 变换（量砍半+伪造伤行），判断层自身在该输入上双峰（同温多轮 66 vs 90+，
  // 自离散 ~35%，无锚可同时覆盖），只打印差值不作门——真 fixture 场景
  // （22/9/5）才是「兜底≠变档」的验收面。
  const injuryRows = slices.filter((s) => s.scenario === "injury" && s.peakDiffPct != null);
  if (injuryRows.length > 0) {
    console.log(
      "injury 场景差值（观测，不入门）：",
      injuryRows.map((s) => `${s.athlete}(中位${s.medianPeakKm} vs 兜${s.fallbackPeakKm}，${((s.peakDiffPct ?? 0) * 100).toFixed(1)}%)`).join(" "),
    );
  }
  const misaligned = slices.filter((s) => s.scenario !== "injury" && s.peakDiffPct != null && s.peakDiffPct > PEAK_ALIGN_TOLERANCE);
  if (misaligned.length > 0) {
    console.error(
      "兜底峰值带与判断层中位不同档（>15%）：",
      misaligned
        .map((s) => `${s.athlete}/${s.scenario}(中位${s.medianPeakKm} vs 兜${s.fallbackPeakKm}，${((s.peakDiffPct ?? 0) * 100).toFixed(1)}%)`)
        .join(" "),
    );
    process.exitCode = 1;
  }
  // T 兜底产物必须永远合法：generate 对兜底已跑同一次门检（outcome.checks），
  // 兜底行仍有 fails = 实现缺陷，直接判失败
  const illegalFallback = calls.filter((c) => c.source === "fallback" && c.fails.length > 0);
  if (illegalFallback.length > 0) {
    console.error("兜底产物挂门（实现缺陷）：", illegalFallback.map((c) => `${c.athlete}/${c.scenario}(${c.fails.join("/")})`).join(" "));
    process.exitCode = 1;
  }
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
