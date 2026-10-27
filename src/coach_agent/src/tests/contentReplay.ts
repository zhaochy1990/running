/**
 * L4 内容生成·真模型回放（devops#811 验收）：
 * - chaoyi×上海马拉松 N=6：#807 迁移 fixture 的周骨架（l4-e2e-shanghai.json
 *   week_rows）+ projectZones 撞帽投影（51.1→52.85 残差 4.4）——规则⑤⑥天然用例；
 * - 三运动员多跑道（9/22 周）：L2 T 表 fallback 意图 + L3 展开（确定性、零 L2 token）。
 * 全链走生产生成编排（deepseek-flash 低温 → C1-C9 校验 → 违规重试 ≤2 → 模板兜底）。
 *
 * 烧 token，不进 CI（门禁层零 token）；本地验收用：
 *   DEEPSEEK_API_KEY=... npm run replay:content
 * 断言=C1-C9 全绿 + 规则抽查（多样性/赛周激活/E 时长/比赛配速=goal_pace±5s/km）；
 * 兜底产物挂门=实现缺陷直接判失败。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAgentConfig, loadConfig, type ModelConfig } from "../config/config.js";
import { isQualityStep } from "../graph/master_plan/phasing/content/derive.js";
import type { ContentWeekRow } from "../graph/master_plan/phasing/content/doctrine.js";
import { createContentModel, generateWeekContent } from "../graph/master_plan/phasing/content/generate.js";
import { projectZones } from "../graph/master_plan/phasing/content/project.js";
import { QUALITY_FAMILY_OF } from "../graph/master_plan/phasing/content/testSupport.js";
import { AS_OF, ATHLETES, type AthleteName, buildAthleteEvidence } from "../graph/master_plan/phasing/fixtureLoader.js";
import { buildLoadPlan } from "../graph/master_plan/phasing/load/expand.js";
import { buildCaseContext, listLoadCases } from "../graph/master_plan/phasing/load/fixtureLoader.js";

const OUT_DIR = resolve(import.meta.dirname, "../../test-output/content-replay");
const RUNWAYS = (process.env.REPLAY_RUNWAYS ?? "9,22").split(",").map(Number);
const RACE_DISTANCE_M = 42195;

function loadModel(): ModelConfig {
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  const config = loadConfig({ configFiles: [resolve(repoRoot, "config/coach.prod.yaml")] });
  return getAgentConfig(config, "master_plan");
}

const parseHms = (s: string) =>
  s
    .split(":")
    .map(Number)
    .reduce((acc, p) => acc * 60 + p, 0);

/** 比赛周周日 = 计划起点周一 + (N−1)×7 + 6。 */
const raceDateOf = (runwayWeeks: number) => new Date(new Date(`${AS_OF}T00:00:00Z`).getTime() + (7 * runwayWeeks - 1) * 86400_000).toISOString().slice(0, 10);

/** chaoyi N=6：#807 spike 周骨架 fixture（input.week_rows）直读。 */
async function fixtureRows(): Promise<Array<Omit<ContentWeekRow, "zones">>> {
  const path = resolve(import.meta.dirname, "../graph/master_plan/phasing/fixtures/l4-e2e-shanghai.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    input: {
      week_rows: Array<{
        no: number;
        phase: string;
        role: ContentWeekRow["role"];
        total_km: number;
        long_run_km: number | null;
        quality_sessions: number;
        quality_family: string;
      }>;
    };
  };
  return raw.input.week_rows.map((r) => ({
    week: r.no,
    phase: r.phase,
    role: r.role,
    totalKm: r.total_km,
    longRunKm: r.long_run_km,
    qualitySessions: r.quality_sessions,
    qualityFamily: r.quality_family,
  }));
}

/**
 * L2 意图 + L3 展开器 → 周骨架行（确定性、零 L2 token）。用 load fixture 冻结的
 * 真实 L2 产出（38 案例 L3 门全绿有保障）——T 表 tableFallback 的体量带与 L3
 * LR 曲线门存在已知错配（devops#810 在途），不作本回放的行来源。
 */
async function fallbackRows(athlete: AthleteName, runwayWeeks: number): Promise<Array<Omit<ContentWeekRow, "zones">>> {
  const cases = await listLoadCases();
  const c = cases.find((x) => x.athlete === athlete && x.scenario === String(runwayWeeks));
  if (c == null) throw new Error(`load fixture 无 ${athlete}/${runwayWeeks} 案例`);
  const ctx = await buildCaseContext(athlete, c.injury);
  const plan = buildLoadPlan({ intent: c.intent, runwayWeeks, baseline: ctx.baseline, recentWeeksKm: ctx.recentWeeksKm });
  const failed = plan.checks.filter((x) => !x.pass);
  if (failed.length > 0) throw new Error(`L3 门挂：${failed.map((x) => `${x.id}:${x.detail}`).join(";")}`);
  return plan.weeks.map((w) => ({
    week: w.week,
    phase: w.canonical,
    role: w.role,
    totalKm: w.km,
    longRunKm: w.lr,
    qualitySessions: w.q,
    qualityFamily: QUALITY_FAMILY_OF[w.canonical] ?? "",
  }));
}

/** 规则抽查（非校验器覆盖的 prompt 规则）：多样性/赛周激活/比赛配速锚。 */
function spotCheck(outcome: Awaited<ReturnType<typeof generateWeekContent>>, input: Parameters<typeof generateWeekContent>[0], goalPaceSKm: number): string[] {
  const issues: string[] = [];
  const flat = outcome.weeks.flatMap(({ week, sessions }) => sessions.map((w) => ({ week, w })));

  // 规则⑤：比赛课处方=goal_pace±5s/km
  const raceRow = input.rows.at(-1)!;
  const raceDate = raceRow.role === "race" ? input.race.date : null;
  if (raceDate != null) {
    const race = flat.find((x) => x.w.date === raceDate);
    if (race == null) issues.push("比赛课缺失");
    else {
      const main = race.w.blocks
        .flatMap((b) => b.steps)
        .find((s) => s.target.kind === "pace_s_km" && s.duration.kind === "distance_m" && s.duration.value > 30000);
      if (main == null || main.target.kind !== "pace_s_km") issues.push("比赛课主段缺失");
      else {
        const mid = (main.target.low + main.target.high) / 2;
        if (Math.abs(mid - goalPaceSKm) > 5) issues.push(`比赛配速 ${main.target.low}-${main.target.high} 偏离 goal ${goalPaceSKm.toFixed(0)} 超±5s/km`);
      }
      // 赛周激活：预算允许时（总账−42.2 ≥ 2km）比赛日前须有非比赛课（短激活 ≤60min）
      if (raceRow.totalKm - 42.195 >= 2 && !flat.some((x) => x.w.date < raceDate && x.w.date >= weekStartOf(input, raceRow.week))) {
        issues.push("赛周无激活/shakeout 课");
      }
      for (const x of flat.filter((y) => y.w.date < raceDate && y.w.date >= weekStartOf(input, raceRow.week) && y.w.type === "E")) {
        const minutes = x.w.blocks.reduce((s, b) => s + b.steps.reduce((t, st) => t + (st.duration.kind === "time_s" ? st.duration.value / 60 : 0), 0), 0);
        if (minutes > 60.5) issues.push(`赛周激活 ${x.w.name} ${minutes.toFixed(0)}min 超短带上限`);
      }
    }
  }

  // 规则②多样性：质量课节数 ≥3 时结构签名不得只有一种（同型只变组数不算新结构）
  const zones = input.rows[0]!.zones;
  const qualitySignatures = new Map<string, number>();
  for (const { week, sessions } of outcome.weeks) {
    if (input.rows[week - 1]!.role === "race") continue;
    for (const w of sessions) {
      if (!w.blocks.some((b) => b.steps.some((s) => isQualityStep(s, zones)))) continue;
      const sig = w.blocks
        .flatMap((b) => b.steps)
        .map((s) => `${s.step_kind}${s.duration.kind === "distance_m" ? Math.round(s.duration.value / 1000) : "t"}`)
        .join("+");
      qualitySignatures.set(sig, (qualitySignatures.get(sig) ?? 0) + 1);
    }
  }
  const qualityCount = [...qualitySignatures.values()].reduce((a, b) => a + b, 0);
  if (qualityCount >= 3 && qualitySignatures.size === 1) issues.push(`质量课结构全同型×${qualityCount}`);
  return issues;
}

const weekStartOf = (input: Parameters<typeof generateWeekContent>[0], week: number) =>
  new Date(new Date(`${input.planStartMonday}T00:00:00Z`).getTime() + (week - 1) * 604800_000).toISOString().slice(0, 10);

interface Scenario {
  athlete: AthleteName;
  runway: number;
  raceName: string;
  rows: Array<Omit<ContentWeekRow, "zones">>;
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("缺 DEEPSEEK_API_KEY（真模型回放烧 token，不进 CI）");
    process.exit(1);
  }
  const model = createContentModel(loadModel());
  await mkdir(OUT_DIR, { recursive: true });

  const scenarios: Scenario[] = [{ athlete: "chaoyi", runway: 6, raceName: "上海马拉松", rows: await fixtureRows() }];
  for (const athlete of Object.keys(ATHLETES) as AthleteName[]) {
    for (const runway of RUNWAYS) scenarios.push({ athlete, runway, raceName: "无锡马拉松", rows: await fallbackRows(athlete, runway) });
  }

  const results: Array<{ athlete: string; scenario: string; source: string; attempts: number; green: boolean; fails: string[]; spot: string[]; ms: number }> =
    [];
  for (const s of scenarios) {
    const spec = ATHLETES[s.athlete];
    const evidence = await buildAthleteEvidence(s.athlete, s.raceName);
    const vdot = evidence.current_capability.vdot;
    if (vdot == null) throw new Error(`${s.athlete} 无当前能力锚（vdot=null），投影不可用`);
    const targetSec = parseHms(spec.targetTime);
    const projection = projectZones(vdot, targetSec, RACE_DISTANCE_M, s.runway);
    const rows: ContentWeekRow[] = s.rows.map((r) => ({ ...r, zones: projection.weeks[r.week - 1]!.zones }));
    const input = {
      rows,
      athlete: {
        weeklyRunDaysMax: spec.weeklyRunDaysMax,
        weekKm: evidence.habitual.week_km,
        fitness: { ctl: evidence.fitness.ctl, atl: evidence.fitness.atl, form: evidence.fitness.form },
      },
      race: { name: s.raceName, date: raceDateOf(s.runway), targetTime: spec.targetTime, goalPaceSKm: targetSec / 42.195 },
      planStartMonday: AS_OF,
    };
    const t0 = Date.now();
    const outcome = await generateWeekContent(input, model);
    const fails = outcome.checks.flatMap((weekChecks) => weekChecks.filter((c) => !c.pass).map((c) => c.id));
    const spot = outcome.source === "llm" ? spotCheck(outcome, input, input.race.goalPaceSKm) : [];
    const row = {
      athlete: s.athlete,
      scenario: String(s.runway),
      source: outcome.source,
      attempts: outcome.attempts,
      green: outcome.source === "llm" && fails.length === 0 && spot.length === 0,
      fails,
      spot,
      ms: Date.now() - t0,
    };
    results.push(row);
    console.log(
      `  ${s.athlete}/${s.runway}w [${projection.meta.capped ? `撞帽residual=${projection.meta.residual}` : "直线抵达"}] ${row.green ? "✓llm" : outcome.source === "fallback" ? "↺兜底" : "✗"} ${row.ms / 1000}s (第${outcome.attempts}次)${row.fails.length ? ` fails=${row.fails.join("/")}` : ""}${row.spot.length ? ` spot=${row.spot.join(";")}` : ""}`,
    );
    await writeFile(
      resolve(OUT_DIR, `content-${s.athlete}-${s.runway}.json`),
      JSON.stringify({ ...row, projection: projection.meta, weeks: outcome.weeks, checks: outcome.checks }, null, 1),
    );
  }

  const green = results.filter((r) => r.green).length;
  const fallback = results.filter((r) => r.source === "fallback").length;
  console.log(`\n回放汇总：${green}/${results.length} 全绿；兜底 ${fallback} 次`);
  const notGreen = results.filter((r) => !r.green);
  if (notGreen.length)
    console.log("未全绿切片：", notGreen.map((r) => `${r.athlete}/${r.scenario}(${[...r.fails, ...r.spot].join("/") || "fallback"})`).join(" "));
  // 兜底产物必须永远合法：兜底行仍挂门 = 实现缺陷，直接判失败
  const illegalFallback = results.filter((r) => r.source === "fallback" && r.fails.length > 0);
  if (illegalFallback.length > 0) {
    console.error("兜底产物挂门（实现缺陷）：", illegalFallback.map((r) => `${r.athlete}/${r.scenario}(${r.fails.join("/")})`).join(" "));
    process.exit(1);
  }
  if (green < results.length) process.exit(1);
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
