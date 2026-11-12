import {
  createMasterPlanGraph,
  createMasterPlanLlmModels,
  DataProviderMasterPlanContextProvider,
  fromMasterArtifact,
  getAgentConfig,
  loadConfig,
  MasterPlanGraphRequest,
  runRollingProjection,
} from "@stride/coach-agent";
import { addDays, mondayOnOrBefore, shanghaiDay } from "@stride/contract";
import { loadApiConfig } from "../src/config.js";
import { coachAgentConfigFiles, coachApiConfigFiles } from "../src/configPaths.js";
import { MySqlDataProvider } from "@stride/coach-agent-worker";
import assert from "node:assert/strict";

/**
 * 滚动出课内核真实数据验收（#858 PR-A Round 1，镜像 test_master_plan.ts）：
 * prod 只读 + 真模型四步——
 *   ① master 生成 18 周计划（requested_as_of=现在−35 天的周一，首批=前 6 周）
 *   ② runRollingProjection(asOf=现在) → completed，覆盖下一块
 *   ③ actualKmScale=0.6 → 批周量收紧（自适应验证）
 *   ④ asOf=首批中段 → no_op
 * env：ROLL_TARGET（缺省 2:50:00）/ ROLL_SHIFT_DAYS（缺省 35）/ ROLL_KM_SCALE
 * （缺省 0.6）/ MP_RACE_DATE / ROLL_DUMP=path（全量 JSON 导出）。
 */

type Profile = "local" | "prod";
const PROFILE = "prod" as Profile;
process.env.STRIDE_COACH_ENV = PROFILE;
const USER_ID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";

const TARGET_TIME = process.env.ROLL_TARGET ?? "2:50:00";
const SHIFT_DAYS = Number(process.env.ROLL_SHIFT_DAYS ?? 35);
const KM_SCALE = Number(process.env.ROLL_KM_SCALE ?? 0.6);
const RUNWAY_WEEKS = 18;

export const config = loadConfig({ configFiles: coachAgentConfigFiles(import.meta.url) });
const modelConfig = getAgentConfig(config, "master_plan");
const phasingConfig = getAgentConfig(config, "phasing");
const contentConfig = getAgentConfig(config, "master_plan");

const store = MySqlDataProvider.create(loadApiConfig({ configFiles: coachApiConfigFiles(import.meta.url) }).strideDatabase);
const provider = new DataProviderMasterPlanContextProvider(store);

// 第一步锚定：requested_as_of 归一到「现在−35 天」所在周的周一——周一锚保证
// 35 天后的「现在」确定落进首批第 6 周（boundary 触发，不随星期几漂移）。
// 比赛日=锚定周一 + 18×7−1 天（第 18 周周日）：+126 整会落到第 19 周周一，
// 触发 content 门口的「比赛日不落在赛周网格」断言（周号公式 ceil 的边界坑）。
const shiftedMonday = mondayOnOrBefore(shanghaiDay(new Date(Date.now() - SHIFT_DAYS * 86_400_000).toISOString()));
const raceDate = process.env.MP_RACE_DATE ?? addDays(shiftedMonday, RUNWAY_WEEKS * 7 - 1);
const nowIso = new Date().toISOString();

const request = MasterPlanGraphRequest.parse({
  request_id: `rolling-master-${Date.now()}`,
  requested_mode: "new_season",
  requested_modifiers: [],
  goals: [
    {
      race_name: "滚动验收马拉松",
      distance: "FM",
      race_date: raceDate,
      target_time: TARGET_TIME,
      finish_only: false,
      priority: "A",
    },
  ],
  availability: {
    weekly_run_days_max: 6,
    available_training_windows: [],
    unavailable_days: [],
    max_session_duration_min: 180,
    allows_double_sessions: true,
    preferred_long_run_day: "sunday",
    strength_sessions_per_week: 2,
    strength_available_days: ["monday", "thursday"],
  },
  injury_declarations: [],
  environment_constraints: [],
  travel_constraints: [],
  preferences: [],
  prohibited_arrangements: [],
  active_plan_action: "none",
  user_confirmations: {
    intake_complete: true,
    goals_confirmed: true,
    availability_confirmed: true,
    injury_history_confirmed: true,
    constraints_confirmed: true,
  },
  requested_as_of: `${shiftedMonday}T10:00:00.000+08:00`,
});

async function main() {
  const llmModels = createMasterPlanLlmModels({ masterPlanModel: modelConfig, phasingModel: phasingConfig, contentModel: contentConfig });
  const rollingDeps = { contextProvider: provider, models: llmModels };
  try {
    // ── 第一步：master 生成 18 周计划（首批=min(首阶段,6) 周） ──
    const graph = createMasterPlanGraph({ contextProvider: provider, ...llmModels });
    const startedAt = Date.now();
    const result = await graph.invoke({ request }, { context: { userId: USER_ID, generationId: `rolling-master-${PROFILE}-${Date.now()}` } });
    console.log(`[step1] master decision=${result.outcome.decision} elapsed=${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
    assert.equal(result.outcome.decision, "completed", `master 未完成：${JSON.stringify(result.outcome).slice(0, 500)}`);
    const artifact = result.outcome.artifact;
    const firstPhaseEnd = artifact.policy.phases.reduce((min, phase) => Math.min(min, phase.end_week), Number.POSITIVE_INFINITY);
    const expectedLastGenerated = Math.min(firstPhaseEnd, 6);
    console.log(
      `[step1] phases=${artifact.policy.phases.map((phase) => `${phase.canonical}W${phase.start_week}-${phase.end_week}`).join(" ")} totalWeeks=${artifact.plan.total_weeks}`,
    );
    console.log(`[step1] blocks=${artifact.skeleton.blocks.map((block) => `B${block.block}[${block.start_week}-${block.end_week}]`).join(" ")}`);
    assert.equal(artifact.plan.total_weeks, RUNWAY_WEEKS, "跑道应为 18 周");
    const master = fromMasterArtifact({
      artifact,
      availability: { weeklyRunDaysMax: request.availability.weekly_run_days_max },
      masterPlanId: `rolling-${PROFILE}-${Date.now()}`,
    });
    assert.equal(master.lastGeneratedWeek, expectedLastGenerated, `首批末周号应=min(首阶段末周,6)=${expectedLastGenerated}`);
    console.log(`[step1] planStart=${master.planStartMonday} lastGeneratedWeek=${master.lastGeneratedWeek}`);

    // ── 第二步：asOf=现在 → completed，批窗覆盖下一块 ──
    const outcome = await runRollingProjection(rollingDeps, { userId: USER_ID, master, asOf: nowIso });
    console.log(`[step2] decision=${outcome.decision}`);
    if (outcome.decision === "infeasible") {
      console.error(`[step2] infeasible：${outcome.reason}`);
      for (const check of outcome.failedChecks) console.error(`  ✗ ${check.id}: ${check.detail}`);
      process.exit(1);
    }
    if (outcome.decision !== "completed") {
      console.log(JSON.stringify(outcome, null, 2).slice(0, 2000));
      throw new Error(`step2 期望 completed，得到 ${outcome.decision}`);
    }
    assert.ok(outcome.window.startWeek >= master.lastGeneratedWeek + 1, "批窗起点应在存量末周之后");
    assert.equal(outcome.weeklyDocs.length, outcome.window.endWeek - outcome.window.startWeek + 1, "周文档数=批窗周数");
    console.log(
      `[step2] window=[${outcome.window.startWeek},${outcome.window.endWeek}] mode=${outcome.window.mode} — ${outcome.window.reason}`,
    );
    console.log(`[step2] vdot(新鲜)=${outcome.evidence.current_capability.vdot}（存量 anchor=${master.anchor.vdot}）`);
    const historyKms = outcome.skeletonNew.weeks.filter((week) => week.week < outcome.window.startWeek).map((week) => week.km);
    if (historyKms.length > 0) console.log(`[step2] 实际完成史 W1..W${outcome.window.startWeek - 1}（historyKm，已固化进新骨架）：${historyKms.join("/")}km`);
    for (const row of outcome.deviation)
      console.log(`[step2]   W${row.week}: 新 ${row.newKm}km vs 存量 ${row.baseKm}km → ${row.pct > 0 ? "+" : ""}${row.pct}%`);
    const { pass, warn, fail } = outcome.audit.summary;
    console.log(`[step2] audit=✅${pass} ⚠️${warn} ❌${fail} source=${outcome.scheduled.source} attempts=${outcome.scheduled.attempts}`);
    for (const item of outcome.audit.items.filter((entry) => entry.verdict !== "pass")) console.log(`  ${item.verdict}: ${item.item} — ${item.actual}`);
    console.log(`[step2] weeklyDocs=${outcome.weeklyDocs.length} 周：${outcome.weeklyDocs.map((doc) => `W${doc.week_index}(${doc.phase_name})`).join(" ")}`);

    // ── 第三步：actualKmScale=0.6 → 批周量收紧（自适应验证：实际完成传得到批窗周） ──
    const tightened = await runRollingProjection(rollingDeps, { userId: USER_ID, master, asOf: nowIso, actualKmScale: KM_SCALE });
    console.log(`[step3] decision=${tightened.decision} scale=${KM_SCALE}`);
    if (tightened.decision === "infeasible") {
      console.error(`[step3] infeasible：${tightened.reason}`);
      for (const check of tightened.failedChecks) console.error(`  ✗ ${check.id}: ${check.detail}`);
      process.exit(1);
    }
    assert.equal(tightened.decision, "completed", `step3 期望 completed，得到 ${tightened.decision}`);
    if (tightened.decision === "completed") {
      const sumOf = (rows: Array<{ newKm: number }>) => rows.reduce((total, row) => total + row.newKm, 0);
      const tightenedSum = sumOf(tightened.deviation);
      const baselineSum = sumOf(outcome.deviation);
      // 逐周对照表（scale=1 vs scale=0.6）：自适应链路可见性
      const baselineByWeek = new Map(outcome.deviation.map((row) => [row.week, row.newKm]));
      console.log(`[step3] 逐周收紧对照（scale=1 vs scale=${KM_SCALE}）：`);
      for (const row of tightened.deviation) {
        const base = baselineByWeek.get(row.week) ?? 0;
        const pct = base > 0 ? ((row.newKm - base) / base) * 100 : 0;
        console.log(`[step3]   W${row.week}: ${base}km → ${row.newKm}km（${pct.toFixed(1)}%，vs 存量骨架 ${row.baseKm}km）`);
      }
      console.log(`[step3] 批周量和：scale=1 → ${baselineSum.toFixed(1)}km，scale=${KM_SCALE} → ${tightenedSum.toFixed(1)}km`);
      const ratio = baselineSum > 0 ? tightenedSum / baselineSum : Number.POSITIVE_INFINITY;
      console.log(`[step3] 收紧比 = ${ratio.toFixed(3)}（要求 ≤ 0.9）`);
      if (!(tightenedSum <= 0.9 * baselineSum)) {
        console.error(`[step3] 自适应断言失败：scale=${KM_SCALE} 批周量和 ${tightenedSum.toFixed(1)}km 未比 scale=1 的 ${baselineSum.toFixed(1)}km 收紧 ≥10%——实际完成没有传导到批窗周`);
        process.exit(1);
      }
    }

    // ── 第四步：asOf=首批中段 → no_op ──（首批中段=存量末周前 2 周的周四，确保 currentWeek < lastGeneratedWeek）
    const midWeek = Math.max(1, master.lastGeneratedWeek - 2);
    const midFirstBatch = `${addDays(master.planStartMonday, (midWeek - 1) * 7 + 3)}T12:00:00.000+08:00`;
    const noop = await runRollingProjection(rollingDeps, { userId: USER_ID, master, asOf: midFirstBatch });
    console.log(`[step4] asOf=${midFirstBatch} decision=${noop.decision}`);
    assert.equal(noop.decision, "no_op", `step4 期望 no_op：${JSON.stringify(noop).slice(0, 500)}`);
    if (noop.decision === "no_op") console.log(`[step4] reason=${noop.reason}`);

    // ── 全量导出（ROLL_DUMP=path） ──
    if (process.env.ROLL_DUMP) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(process.env.ROLL_DUMP, JSON.stringify({ master, window: outcome.window, deviation: outcome.deviation, weeklyDocs: outcome.weeklyDocs, skeletonNew: outcome.skeletonNew, audit: outcome.audit }, null, 1));
      console.log(`dumped -> ${process.env.ROLL_DUMP}`);
    }
    console.log("[rolling] 四步断言全过 ✅");
  } finally {
    await store.close();
  }
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
