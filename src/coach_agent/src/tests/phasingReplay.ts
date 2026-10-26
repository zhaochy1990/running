/**
 * 阶段划分意图层·真模型回放（devops#782 F 节验收）：
 * 三运动员 fixture × 场景 {22, 9, 5, injury}，走生产判断层链路
 * （deepseek-flash → 结构门 → 违规重试 ≤2 → T 兜底）。
 *
 * 烧 token，不进 CI（门禁层零 token）；本地验收用：
 *   DEEPSEEK_API_KEY=... npm run replay:phasing
 * 过门率基线：flash 首版 15 切片 14 绿（spike 第六轮+v2 轮），
 * 本链路含重试，最终 source=llm 且全绿的比例不应低于 13/15。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAgentConfig, loadConfig, type ModelConfig } from "../config/config.js";
import type { PhaseEvidence } from "../graph/master_plan/phasing/evidence.js";
import { AS_OF, ATHLETES, type AthleteName, applyInjuryScenario, buildAthleteEvidence } from "../graph/master_plan/phasing/fixtureLoader.js";
import { createPhasingModel, generatePhaseDivisionIntent } from "../graph/master_plan/phasing/generate.js";

const OUT_DIR = resolve(import.meta.dirname, "../../test-output/phasing-replay");
const SCENARIOS = (process.env.REPLAY_SCENARIOS ?? "22,9,5,injury").split(",");
const RUNWAY_OF: Record<string, number> = { injury: 22 };

function loadModel(): ModelConfig {
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  const config = loadConfig({ configFiles: [resolve(repoRoot, "config/coach.prod.yaml")] });
  return getAgentConfig(config, "master_plan");
}

const raceDateOf = (weeks: number) => new Date(new Date(`${AS_OF}T00:00:00Z`).getTime() + (7 * weeks - 1) * 86400_000).toISOString().slice(0, 10);

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("缺 DEEPSEEK_API_KEY（真模型回放烧 token，不进 CI）");
    process.exit(1);
  }
  const model = createPhasingModel(loadModel());
  await mkdir(OUT_DIR, { recursive: true });
  const results: Array<{ athlete: string; scenario: string; source: string; attempts: number; green: boolean; fails: string[]; ms: number; layout: string }> =
    [];

  for (const athlete of Object.keys(ATHLETES) as AthleteName[]) {
    const baseEvidence = await buildAthleteEvidence(athlete);
    for (const scenario of SCENARIOS) {
      const N = RUNWAY_OF[scenario] ?? Number(scenario);
      const evidence: PhaseEvidence = scenario === "injury" ? applyInjuryScenario(baseEvidence) : baseEvidence;
      const t0 = Date.now();
      const outcome = await generatePhaseDivisionIntent({ evidence, runwayWeeks: N, raceDate: raceDateOf(N) }, model);
      // source=fallback 时 outcome.checks 是兜底自身的门（构造保证全绿），
      // 观测口径另算：判断层最终产物是否可用（source=llm）+ 兜底率
      const layout = [...outcome.intent.phases]
        .sort((a, b) => a.start_week - b.start_week)
        .map((p) => `${p.canonical.replace("_quality", "Q").replace("foundation", "F")}${p.end_week - p.start_week + 1}`)
        .join("+");
      const fails = outcome.checks.filter((c) => !c.pass).map((c) => c.id);
      const row = {
        athlete,
        scenario,
        source: outcome.source,
        attempts: outcome.attempts,
        green: outcome.source === "llm" && fails.length === 0,
        fails,
        ms: Date.now() - t0,
        layout,
      };
      results.push(row);
      console.log(
        `  ${athlete}/${scenario} [${layout}] taper${outcome.intent.taper_weeks}w ${row.green ? "✓llm" : outcome.source === "fallback" ? "↺兜底" : "✗"} ${row.ms / 1000}s (第${outcome.attempts}次)`,
      );
      await writeFile(
        resolve(OUT_DIR, `phasing-${athlete}-${scenario}.json`),
        JSON.stringify({ ...row, intent: outcome.intent, checks: outcome.checks }, null, 1),
      );
    }
  }

  const green = results.filter((r) => r.green).length;
  const fallback = results.filter((r) => r.source === "fallback").length;
  console.log(`\n回放汇总：${green}/${results.length} 判断层全绿；兜底 ${fallback} 次；目标 ≥ ${Math.ceil((results.length * 13) / 15)}/${results.length}`);
  if (results.some((r) => !r.green)) {
    console.log(
      "未全绿切片：",
      results
        .filter((r) => !r.green)
        .map((r) => `${r.athlete}/${r.scenario}(${r.fails.join("/") || "fallback"})`)
        .join(" "),
    );
  }
  // T 兜底产物必须永远合法：generate 对兜底已跑同一次门检（outcome.checks），
  // 兜底行仍有 fails = 实现缺陷，直接判失败
  const illegalFallback = results.filter((x) => x.source === "fallback" && x.fails.length > 0);
  if (illegalFallback.length > 0) {
    console.error("兜底产物挂门（实现缺陷）：", illegalFallback.map((x) => `${x.athlete}/${x.scenario}(${x.fails.join("/")})`).join(" "));
    process.exit(1);
  }
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
