/**
 * #858 PR-C 真实数据验收脚本（adjust 引擎）：prod 只读真数据 + 真 LLM。
 *
 * 链路：master 生成（asOf 前移 → 首批课表）→ 真实活动跑 assessWeek（最近完整周
 * 对首批内某周课）→ runAdjustProjection（按预判原因的配方重生成剩余周）→ 断言
 * completed、窗口 ⊆ 已生成周、周文档合法、diff 打印。Go 同意流（upsert/choose/
 * accept）与存储不变量在 Go 单测与 DSN 门控集成测试覆盖；夜检闭环在 R6 e2e。
 *
 * 运行：npm run build 后
 *   STRIDE_COACH_ENV=prod node dist/scripts/test_adjust.js
 * env：ADJ_TARGET（缺省 2:50:00）、ADJ_SHIFT_DAYS（缺省 35）、ADJ_EVENT_WEEK
 * （缺省=最近一个完整周的周一）、ADJ_REASON（缺省=检测 preselect）、ROLL_DUMP。
 */
import {
  assessWeek,
  createMasterPlanGraph,
  createMasterPlanLlmModels,
  DataProviderMasterPlanContextProvider,
  fromMasterArtifact,
  getAgentConfig,
  loadConfig,
  runAdjustProjection,
  type ActivityRef,
  type AskReason,
  type WeekDeviation,
} from "@stride/coach-agent";
import { addDays, MasterPlanGraphRequest, mondayOnOrBefore, shanghaiDay } from "@stride/contract";
import { writeFileSync } from "node:fs";
import { loadApiConfig } from "../src/config.js";
import { coachAgentConfigFiles, coachApiConfigFiles } from "../src/configPaths.js";
import { MySqlDataProvider } from "@stride/coach-agent-worker";

type Profile = "local" | "prod";
const PROFILE = "prod" as Profile;
process.env.STRIDE_COACH_ENV = PROFILE;
const USER_ID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
const SHIFT_DAYS = Number(process.env.ADJ_SHIFT_DAYS ?? 28);
const TARGET = process.env.ADJ_TARGET ?? "2:50:00";

export const config = loadConfig({ configFiles: coachAgentConfigFiles(import.meta.url) });
const modelConfig = getAgentConfig(config, "master_plan");
const phasingConfig = getAgentConfig(config, "phasing");
const contentConfig = getAgentConfig(config, "master_plan");
const store = MySqlDataProvider.create(loadApiConfig({ configFiles: coachApiConfigFiles(import.meta.url) }).strideDatabase);
const provider = new DataProviderMasterPlanContextProvider(store);

function assertOk(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`[adjust] 断言失败：${message}`);
    process.exit(1);
  }
}

async function main() {
  // ── ① master 生成（asOf 前移 SHIFT_DAYS 天 → 首批=min(首阶段,6) 周）──
  const shiftedAsOf = addDays(shanghaiDay(new Date().toISOString()), -SHIFT_DAYS);
  const raceDate = process.env.ADJ_RACE_DATE ?? addDays(shiftedAsOf, 18 * 7 - 1);
  const request = MasterPlanGraphRequest.parse({
    request_id: `adjust-master-${Date.now()}`,
    requested_mode: "new_season",
    requested_modifiers: [],
    goals: [
      { race_name: "上海马拉松", distance: "FM", race_date: raceDate, target_time: TARGET, finish_only: false, priority: "A" },
    ],
    availability: {
      weekly_run_days_max: 6, available_training_windows: [], unavailable_days: [], max_session_duration_min: 180,
      allows_double_sessions: true, preferred_long_run_day: "sunday",
      strength_sessions_per_week: 2, strength_available_days: ["monday", "thursday"],
    },
    injury_declarations: [], environment_constraints: [], travel_constraints: [], preferences: [],
    prohibited_arrangements: [], active_plan_action: "none",
    user_confirmations: { intake_complete: true, goals_confirmed: true, availability_confirmed: true, injury_history_confirmed: true, constraints_confirmed: true },
    requested_as_of: new Date(`${shiftedAsOf}T12:00:00+08:00`).toISOString(),
  });
  const llmModels = createMasterPlanLlmModels({ masterPlanModel: modelConfig, phasingModel: phasingConfig, contentModel: contentConfig });
  const graph = createMasterPlanGraph({ contextProvider: provider, ...llmModels });
  console.log(`[step1] master 生成 as_of=${shiftedAsOf} race=${raceDate} target=${TARGET}`);
  const result = await graph.invoke({ request }, { context: { userId: USER_ID, generationId: `adjust-${Date.now()}` } });
  assertOk(result.outcome.decision === "completed", `master 未完成：${JSON.stringify(result.outcome).slice(0, 300)}`);
  const artifact = result.outcome.artifact;
  const master = fromMasterArtifact({ artifact, availability: { weeklyRunDaysMax: 6 }, masterPlanId: "adjust-e2e" });
  console.log(`[step1] completed：totalWeeks=${master.totalWeeks} lastGeneratedWeek=${master.lastGeneratedWeek} weeklyDocs=${artifact.weekly_docs?.length ?? 0} 周`);

  // ── ② 真实活动 → 事件周偏差检测（事件周=已落库首批内、最近完整周）──
  const thisMonday = mondayOnOrBefore(shanghaiDay(new Date().toISOString()));
  const eventWeek = process.env.ADJ_EVENT_WEEK ?? addDays(thisMonday, -7);
  const eventDoc = (artifact.weekly_docs ?? []).find((doc) => doc.week_name.slice(0, 10) === eventWeek) ?? null;
  assertOk(eventDoc !== null, `事件周 ${eventWeek} 不在首批周课内（首批 ${(artifact.weekly_docs ?? []).map((doc) => doc.week_name.slice(0, 10)).join(",")}）`);
  const summaries = await store.getActivitySummariesByDateRange(USER_ID, eventWeek, addDays(eventWeek, 6));
  const activities: ActivityRef[] = summaries
    .filter((row) => row.sport?.toLowerCase().startsWith("run") === true || row.sportName?.toLowerCase().includes("run") === true)
    .map((row) => ({
      day: row.shanghaiDay,
      name: row.name ?? "(未命名)",
      distanceKm: Math.round(((row.distanceM ?? 0) / 1000) * 100) / 100,
      durationS: row.durationS ?? 0,
      avgPaceSKm: row.avgPaceSKm,
      sessionClass: row.strideSessionClass,
    }));
  let deviation: WeekDeviation = assessWeek({ weekDoc: eventDoc!, activities });
  console.log(`[step2] 事件周 ${eventWeek}：${deviation.evidence}`);
  console.log(`[step2] 分类=${deviation.class} preselect=${deviation.preselect} severe=${deviation.severe}`);
  if (deviation.class === "within_tolerance") {
    // 真实周恰好贴合计划（检测层已有独立验收）→ 注入合成偏差驱动引擎验收。
    deviation = {
      ...deviation,
      class: "volume_short", preselect: "no_time", severe: false,
      evidence: `${deviation.evidence}；（注入合成偏差：量没练完场景驱动配方引擎验收）`,
    };
    console.log("[step2] 真实周在容忍内 → 注入 volume_short/no_time 合成偏差");
  }

  // ── ③ runAdjustProjection（预判原因的配方）──
  const reason = (process.env.ADJ_REASON ?? deviation.preselect ?? "no_time") as AskReason;
  const existingWeeks = (artifact.weekly_docs ?? []).map((doc, index) => ({
    weekStart: doc.week_name.slice(0, 10),
    week: index + 1,
    km: doc.target_weekly_km_low ?? 0,
  }));
  console.log(`[step3] runAdjustProjection reason=${reason} existingWeeks=${existingWeeks.map((week) => `W${week.week}(${week.km}km)`).join(",")}`);
  const existingDocs = artifact.weekly_docs ?? [];
  const outcome = await runAdjustProjection(
    { contextProvider: provider, models: llmModels },
    { userId: USER_ID, master, asOf: new Date().toISOString(), deviation, reason, existingWeeks, existingDocs },
  );
  assertOk(outcome.decision === "completed", `adjust 未完成（${outcome.decision}）：${"reason" in outcome ? outcome.reason : JSON.stringify(outcome).slice(0, 300)}`);
  console.log(`[step3] completed：窗口 W${outcome.window.startWeek}-W${outcome.window.endWeek}`);
  console.log(`[step3] audit=${outcome.audit.summary.pass}✅ ${outcome.audit.summary.warn}⚠️ ${outcome.audit.summary.fail}❌ source=${outcome.weeklyDocs[0]?.source ?? "?"}`);
  assertOk(outcome.window.endWeek <= master.lastGeneratedWeek, "调整窗口不得越出已生成周（不出新周，边界归滚动）");
  assertOk(outcome.weeklyDocs.length === outcome.window.endWeek - outcome.window.startWeek + 1, "周文档数=窗口周数");
  for (const doc of outcome.weeklyDocs) assertOk(doc.sessions.length > 0, `周 ${doc.week_name} 无会话`);

  // ── ④ diff 打印（新 km vs 旧 km）──
  console.log("[step4] diff（旧km → 新km）：");
  for (const row of outcome.diff) console.log(`   W${row.week}: ${row.oldKm} → ${row.newKm}（${row.oldKm > 0 ? Math.round(((row.newKm - row.oldKm) / row.oldKm) * 1000) / 10 : 0}%）`);
  const firstDoc = outcome.weeklyDocs[0]!;
  console.log(`[step4] 首周文档抽验：${firstDoc.week_name} coach_notes=${firstDoc.coach_notes?.slice(0, 60)}…`);

  if (process.env.ROLL_DUMP) {
    writeFileSync(process.env.ROLL_DUMP, JSON.stringify({ deviation, reason, window: outcome.window, diff: outcome.diff, weeklyDocs: outcome.weeklyDocs, audit: outcome.audit }, null, 1));
    console.log(`dumped -> ${process.env.ROLL_DUMP}`);
  }
  console.log("[adjust] 断言全过 ✅");
  process.exit(0);
}

main().catch((error) => {
  console.error("[adjust] 失败：", error);
  process.exit(1);
});
