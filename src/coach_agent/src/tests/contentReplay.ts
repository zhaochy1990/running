/**
 * L4 内容+排位全链·真模型回放（devops#811 建立、#799 扩 L4b 排位段）：
 * - chaoyi×上海马拉松 N=6：#807 迁移 fixture 的周骨架（l4-e2e-shanghai.json
 *   week_rows）+ projectZones 撞帽投影（51.1→52.85 残差 4.4）——规则⑤⑥天然用例；
 * - 三运动员多跑道（9/22 周）：L2 T 表 fallback 意图 + L3 展开（确定性、零 L2 token）。
 * 全链走生产编排（deepseek-flash 低温 → 课包校验 → L4b 波浪排位 → P 门+C 终检 →
 * 违规重试 ≤2 → 模板兜底课包+排位）。
 *
 * 烧 token，不进 CI（门禁层零 token）；本地验收用：
 *   DEEPSEEK_API_KEY=... npm run replay:content
 * 断言=课包/排位/终检全绿 + 规则抽查（多样性/赛周激活/E 时长/比赛配速锚 goal_pace）+
 * 波浪带内（POC wave-poc.mjs 对照：峰 ≤cap1.3、建设周锯齿显形、LR 周日/周六轻量/Q 隔日）；
 * 结构性无解（种子×L3 包络 P6 越 cap，如伤退低 CTL 长跑道）=设计内上浮路径，
 * 记账为 escalated 并断言原因含 P6——不当失败也不静默。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getLogger } from "@stride/common";
import { getAgentConfig, loadConfig, type ModelConfig } from "../config/config.js";
import { isQualityStep, mainQualitySegment } from "../graph/master_plan/phasing/content/derive.js";
import type { ContentWeekRow } from "../graph/master_plan/phasing/content/doctrine.js";
import { createContentModel, generateWeekContent, type ScheduledOutcome } from "../graph/master_plan/phasing/content/generate.js";
import { projectZones } from "../graph/master_plan/phasing/content/project.js";
import { QUALITY_FAMILY_OF } from "../graph/master_plan/phasing/content/testSupport.js";
import { AS_OF, ATHLETES, type AthleteName, buildAthleteEvidence } from "../graph/master_plan/phasing/fixtureLoader.js";
import { buildLoadPlan } from "../graph/master_plan/phasing/load/expand.js";
import { buildCaseContext, listLoadCases } from "../graph/master_plan/phasing/load/fixtureLoader.js";

const OUT_DIR = resolve(import.meta.dirname, "../../test-output/content-replay");
const RUNWAYS = (process.env.REPLAY_RUNWAYS ?? "9,22").split(",").map(Number);
const RACE_DISTANCE_M = 42195;
const logger = getLogger("coachAgent:contentReplay");

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
  return raw.input.week_rows
    .map((r) => {
      // 赛周行覆写为当前 L3 契约形（#809 下限 42.2+10、#825 q=2=比赛课+M 激活）：
      // 迁移样本冻结于 #807（45.3/q=1）供 migrate.test 钉真实教练基线；生成侧按
      // 现行契约跑——45.3 骨架装不下 M 激活课（C1 数学无解）
      if (r.role === "race") return { ...r, total_km: 52.2, quality_sessions: 2 };
      return r;
    })
    .map((r) => ({
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

/** 规则抽查（非校验器覆盖的 prompt 规则）：多样性/赛周激活/比赛配速锚/#837 M 专项与长跑 goal 段。 */
function spotCheck(outcome: ScheduledOutcome, input: Parameters<typeof generateWeekContent>[0], goalPaceSKm: number): string[] {
  const issues: string[] = [];
  const flat = outcome.weeks.flatMap(({ week, sessions }) => sessions.map((w) => ({ week, w })));

  // #837 验收口径：M 课=比赛专项，主段 mid 不得比 goal 慢 12s+（宽松合理性断言，
  // 覆盖爬坡期照带快端的教义合规区间；final_quality 期 ≤8s 由 C13 硬校验强制）
  const rowOfWeek = new Map(input.rows.map((r) => [r.week, r]));
  for (const { week, w } of flat) {
    if (w.type !== "M" || w.date === input.race.date) continue;
    const row = rowOfWeek.get(week);
    if (row == null) continue;
    const main = mainQualitySegment(w, row.zones);
    if (main == null || main.step.target.kind !== "pace_s_km") continue;
    const mid = (main.step.target.low + main.step.target.high) / 2;
    if (mid > input.race.goalPaceSKm + 12)
      issues.push(
        `第${week}周 ${w.name} M 主段 mid ${Math.round(mid)} 比 goal ${Math.round(input.race.goalPaceSKm)} 慢 ${(mid - input.race.goalPaceSKm).toFixed(1)}s`,
      );
  }

  // #837 final_quality 进展周长跑必须含 goal_pace 段（纯有氧只留给 recovery 与
  // 减量性质周 absorb/taper；race 无 LR）：LR 的 work 步须有一段贴 goal（专项段
  // goal±5 / MP 长跑全程 / 渐加速尾段 goal−5）
  for (const { week, sessions } of outcome.weeks) {
    const row = rowOfWeek.get(week);
    if (row == null || row.phase !== "final_quality" || row.role !== "progress") continue;
    for (const w of sessions.filter((x) => x.type === "LR")) {
      // ≥1km 的 goal 段即认可（含变速长跑 1km@goal×N 的间歇式暴露——票面三形态之外
      // 的合法变体，专项刺激在场；<1km 是 strides 级触感不算）
      const hasGoalSeg = w.blocks.some((b) =>
        b.steps.some((st) => {
          if (st.target.kind !== "pace_s_km" || st.duration.kind !== "distance_m" || st.duration.value < 1000) return false;
          const mid = (st.target.low + st.target.high) / 2;
          return Math.abs(mid - input.race.goalPaceSKm) <= 10;
        }),
      );
      if (!hasGoalSeg) issues.push(`第${week}周 ${w.name} final_quality 长跑无 goal_pace 段（专项长跑/MP 长跑/渐加速尾段三选一）`);
    }
  }

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
      const weekStart = new Date(new Date(`${input.planStartMonday}T00:00:00Z`).getTime() + (raceRow.week - 1) * 604800_000).toISOString().slice(0, 10);
      if (raceRow.totalKm - 42.195 >= 2 && !flat.some((x) => x.w.date < raceDate && x.w.date >= weekStart)) {
        issues.push("赛周无激活/shakeout 课");
      }
      for (const x of flat.filter((y) => y.w.date < raceDate && y.w.date >= weekStart && y.w.type === "E")) {
        // 与 C9 完全同口径：rest/recovery 步与 strides（open 短触感步）不计时长，repeat 展开
        const minutes = x.w.blocks.reduce((s, b) => {
          const perRep = b.steps.reduce((t, st) => {
            if (st.step_kind === "rest" || st.step_kind === "recovery") return t;
            const isStride =
              st.target.kind === "open" &&
              ((st.duration.kind === "distance_m" && st.duration.value <= 100) || (st.duration.kind === "time_s" && st.duration.value < 30));
            if (isStride) return t;
            return t + (st.duration.kind === "time_s" ? st.duration.value / 60 : 0);
          }, 0);
          return s + b.repeat * perRep;
        }, 0);
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

/** 波浪统计（POC wave-poc.mjs 对照）：建设周锯齿（峰谷差）、全段峰谷、比值 cap。 */
function waveStats(outcome: ScheduledOutcome, raceDate: string | null): { sawtooth: number; peak: number; valley: number; capOk: boolean } {
  // 比赛日豁免同 P6 门——马拉松当日剂量必然冲高（目标事件非可调度负荷）
  const pts = outcome.loadSeries.filter((p) => p.date !== raceDate);
  const byWeek = new Map<number, number[]>();
  for (const p of pts) byWeek.set(p.week, [...(byWeek.get(p.week) ?? []), p.ratio ?? 0]);
  const sawtooth = Math.max(0, ...[...byWeek.entries()].map(([, rs]) => (rs.length > 0 ? Math.max(...rs) - Math.min(...rs) : 0)));
  const all = pts.map((p) => p.ratio ?? 0);
  return { sawtooth, peak: Math.max(...all), valley: Math.min(...all), capOk: all.every((r) => r <= 1.31) };
}

interface Scenario {
  athlete: AthleteName | "chaoyi-fixture";
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

  const scenarios: Scenario[] = [{ athlete: "chaoyi-fixture", runway: 6, raceName: "上海马拉松", rows: await fixtureRows() }];
  for (const athlete of Object.keys(ATHLETES) as AthleteName[]) {
    for (const runway of RUNWAYS) scenarios.push({ athlete, runway, raceName: "无锡马拉松", rows: await fallbackRows(athlete, runway) });
  }

  const results: Array<{
    athlete: string;
    scenario: string;
    source: string;
    attempts: number;
    green: boolean;
    escalated?: string;
    fails: string[];
    spot: string[];
    wave?: ReturnType<typeof waveStats>;
    ms: number;
  }> = [];
  for (const s of scenarios) {
    const evidenceAthlete = s.athlete === "chaoyi-fixture" ? "chaoyi" : s.athlete;
    const spec = ATHLETES[evidenceAthlete as AthleteName];
    const evidence = await buildAthleteEvidence(evidenceAthlete as AthleteName, s.raceName);
    const vdot = evidence.current_capability.vdot;
    if (vdot == null) throw new Error(`${evidenceAthlete} 无当前能力锚（vdot=null），投影不可用`);
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
      race: { name: s.raceName, date: raceDateOf(s.runway), targetTime: spec.targetTime, goalPaceSKm: targetSec / 42.195, goalMPace: projection.goal_m_pace },
      planStartMonday: AS_OF,
    };
    const t0 = Date.now();
    try {
      const outcome = await generateWeekContent(input, model);
      // 可观测性（#822，#814 Phase 1）：重试违规全量出日志，供失败归因采集
      if (outcome.attemptsDetail.length > 0) {
        logger.warn(
          { athlete: s.athlete, scenario: String(s.runway), source: outcome.source, attempts: outcome.attempts, attemptsDetail: outcome.attemptsDetail },
          "content generation retry violations",
        );
      }
      const fails = [
        ...outcome.checks.flatMap((weekChecks) => weekChecks.filter((c) => !c.pass).map((c) => c.id)),
        ...outcome.scheduleChecks.flatMap((weekChecks) => weekChecks.filter((c) => !c.pass).map((c) => c.id)),
      ];
      const spot = outcome.source === "llm" ? spotCheck(outcome, input, input.race.goalPaceSKm) : [];
      const wave = waveStats(outcome, raceDateOf(s.runway));
      const row = {
        athlete: s.athlete,
        scenario: String(s.runway),
        source: outcome.source,
        attempts: outcome.attempts,
        green: outcome.source === "llm" && fails.length === 0 && spot.length === 0 && wave.capOk,
        fails,
        spot,
        wave,
        ms: Date.now() - t0,
      };
      results.push(row);
      console.log(
        `  ${s.athlete}/${s.runway}w [${projection.meta.capped ? `撞帽residual=${projection.meta.residual}` : "直线抵达"}] ${row.green ? "✓llm" : outcome.source === "fallback" ? "↺兜底" : "✗"} ${row.ms / 1000}s (第${outcome.attempts}次) 峰${wave.peak.toFixed(2)}/谷${wave.valley.toFixed(2)}/锯齿${wave.sawtooth.toFixed(2)}${row.fails.length ? ` fails=${row.fails.join("/")}` : ""}${row.spot.length ? ` spot=${row.spot.join(";")}` : ""}`,
      );
      await writeFile(
        resolve(OUT_DIR, `content-${s.athlete}-${s.runway}.json`),
        JSON.stringify(
          {
            ...row,
            attemptsDetail: outcome.attemptsDetail,
            projection: projection.meta,
            weeks: outcome.weeks,
            checks: outcome.checks,
            scheduleChecks: outcome.scheduleChecks,
            calendar: outcome.calendar,
            loadSeries: outcome.loadSeries,
            loadMeta: outcome.loadMeta,
            repairs: outcome.repairs,
          },
          null,
          1,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 结构性无解（P6 波形 cap 等：种子×L3 包络联合属性）=设计内上浮路径——记账并断言原因
      if (message.includes("L4 结构性无解")) {
        results.push({
          athlete: s.athlete,
          scenario: String(s.runway),
          source: "escalated",
          attempts: 0,
          green: false,
          escalated: message.slice(0, 300),
          fails: [],
          spot: [],
          ms: Date.now() - t0,
        });
        console.log(`  ${s.athlete}/${s.runway}w ↑上浮 ${message.slice(0, 140)}`);
        continue;
      }
      throw error;
    }
  }

  const green = results.filter((r) => r.green).length;
  const legalFallback = results.filter((r) => r.source === "fallback" && r.fails.length === 0 && (r.wave?.capOk ?? true));
  const escalated = results.filter((r) => r.escalated != null);
  console.log(
    `\n回放汇总：llm 全绿 ${green}；合法兜底 ${legalFallback.length}；结构性上浮 ${escalated.length}；共 ${results.length}——验收口径=全场景日历合法+波浪带内（兜底率=可观测性归 #823/#798 质量线）`,
  );
  const notGreen = results.filter((r) => !r.green && r.escalated == null);
  if (notGreen.length)
    console.log("未全绿切片：", notGreen.map((r) => `${r.athlete}/${r.scenario}(${[...r.fails, ...r.spot].join("/") || "fallback"})`).join(" "));
  // 兜底产物必须永远合法：兜底行仍挂门 = 实现缺陷，直接判失败
  const illegalFallback = results.filter((r) => r.source === "fallback" && r.fails.length > 0);
  if (illegalFallback.length > 0) {
    console.error("兜底产物挂门（实现缺陷）：", illegalFallback.map((r) => `${r.athlete}/${r.scenario}(${r.fails.join("/")})`).join(" "));
    process.exit(1);
  }
  // 上浮必须全部为结构性原因（P6 波形 cap）——其它上浮=实现缺陷
  for (const r of escalated) {
    if (!/P6/.test(r.escalated ?? "")) {
      console.error(`非 P6 结构性上浮（实现缺陷嫌疑）：${r.athlete}/${r.scenario} ${r.escalated}`);
      process.exit(1);
    }
  }
  if (green + legalFallback.length + escalated.length < results.length) process.exit(1);
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
