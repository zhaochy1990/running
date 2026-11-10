/**
 * #858 PR-C 下半验收脚本（夜检扫描 rolling-scan）：
 *
 * 默认 dry-run（零 LLM，prod 只读）：
 *   枚举 prod active v3 master 计划（listActiveMasterPlans，只读）→ 逐用户跑
 *   judgeUserScan（真实已落库 weekly 行 + 最近完整周真实活动）→ 判定结果表
 *   （边界窗口 / 事件周偏差分类 / 是否 enqueue + 幂等键）→ 断言判定输出与
 *   computeRollingWindow / assessWeek 直调一致（assertDecisionConsistent）。
 *   prod 无 active v3 行时用 SCAN_MASTER_CONTENT=<content JSON 路径>（master
 *   生成产物）在内存构造 content 走同一判定函数。
 *
 * APPLY=1（有 LLM，写操作只打一次性 docker mysql，不碰生产库）：
 *   master 生成（asOf 前移 28 天，失败重试一次）→ 首批物化（内存）→ 扫描判定
 *   函数（喂构造的 content+周行）→ 断言输出含滚动窗或偏差事件 → 对偏差事件跑
 *   generate_adjustment handler（create_pending 路径，fake channel 断言 upsert
 *   调用）→ upsert 产物（user/master/event/reason/question/payload）交 Go e2e
 *   集成测试（docker mysql，模式照 test_rolling_e2e）断言 pending 行建立 +
 *   payload 原样落库 + 同事件重投刷新 + 事件关闭 409。
 *
 * 运行：npm run build 后
 *   STRIDE_COACH_ENV=prod node dist/scripts/test_scan.js
 * env：SCAN_DRY_AS_OF（判定时点回放，缺省=现在）、SCAN_MASTER_CONTENT（无
 * active v3 行时的 content 兜底）、APPLY=1（LLM e2e）、SCAN_KEEP_DB=1、
 * ROLL_DUMP（判定表 JSON 导出）。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import {
  assessWeek,
  createMasterPlanGraph,
  createMasterPlanLlmModels,
  DataProviderMasterPlanContextProvider,
  getAgentConfig,
  loadConfig,
  masterPlanToContent,
  type AskReason,
  storedWeeklyDocOf,
  type WeekDeviation,
} from "@stride/coach-agent";
import { MySqlDataProvider, createAdjustJobHandler, type AdjustHandlerDeps } from "@stride/coach-agent-worker";
import { addDays, mondayOnOrBefore, shanghaiDay, type WeeklyPlan } from "@stride/contract";
import { loadApiConfig } from "../src/config.js";
import { assertDecisionConsistent, judgeUserScan, toScanActivityRefs, type ScanPlanRef } from "../src/coach/rollingScan.js";
import { coachAgentConfigFiles, coachApiConfigFiles } from "../src/configPaths.js";

const run = promisify(execFile);

type Profile = "local" | "prod";
const PROFILE = "prod" as Profile;
process.env.STRIDE_COACH_ENV = PROFILE;
const USER_ID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
const APPLY = process.env.APPLY === "1";
const SHIFT_DAYS = Number(process.env.SCAN_SHIFT_DAYS ?? 28);

export const config = loadConfig({ configFiles: coachAgentConfigFiles(import.meta.url) });
const store = MySqlDataProvider.create(loadApiConfig({ configFiles: coachApiConfigFiles(import.meta.url) }).strideDatabase);
const provider = new DataProviderMasterPlanContextProvider(store);

/** LLM 真调用失败先重试一次再报告（约定：最多两次尝试）。 */
async function withOneRetry<T>(label: string, attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    console.warn(`[${label}] 第一次尝试失败，重试一次：${error instanceof Error ? error.message : String(error)}`);
    return await attempt();
  }
}

function printJudgmentTable(rows: Array<Record<string, unknown>>): void {
  const header = ["user", "currentW", "lastGen", "滚动窗", "事件周偏差", "enqueue"];
  console.log(`[scan] ${header.join(" | ")}`);
  for (const row of rows) {
    console.log(`[scan] ${[row.user, row.currentW, row.lastGen, row.rolling, row.deviation, row.enqueued].join(" | ")}`);
  }
}

// ── dry-run（零 LLM，prod 只读）──────────────────────────────────────────────

async function dryRun(): Promise<void> {
  const asOf = process.env.SCAN_DRY_AS_OF ?? new Date().toISOString();
  const asOfDay = shanghaiDay(asOf);
  const eventWeek = addDays(mondayOnOrBefore(asOfDay), -7);
  console.log(`[dry] 判定时点 asOf=${asOf}（上海日 ${asOfDay}），最近完整周=${eventWeek}`);

  // ① 枚举 active v3 计划；无行时回退 SCAN_MASTER_CONTENT（内存构造）。
  let plans: ScanPlanRef[] = await store.listActiveMasterPlans();
  if (plans.length === 0) {
    const contentPath = process.env.SCAN_MASTER_CONTENT ?? "";
    assert.ok(contentPath !== "" && existsSync(contentPath), "prod 无 active v3 master 行：需 SCAN_MASTER_CONTENT=<master 生成产物 JSON 路径> 兜底");
    const raw = JSON.parse(await readFile(contentPath, "utf8")) as Record<string, unknown>;
    // 两种产物形状都收：worker 落库 content（masterPlanToContent 产物）或 master
    // 图原始 artifact（type=master_plan_draft + plan/policy/skeleton/anchor）——
    // 后者在此用同一 transform 构造 content（零 LLM）。
    let content: Record<string, unknown>;
    if (typeof raw.plan === "object" && raw.plan !== null && raw.type === "master_plan_draft") {
      const artifact = raw as unknown as {
        plan: Parameters<typeof masterPlanToContent>[0];
        policy: unknown;
        skeleton: unknown;
        anchor: unknown;
      };
      content = masterPlanToContent(artifact.plan, "11111111-2222-3333-4444-555555555555", { weekly_run_days_max: 6 });
      content.master_plan_id = randomUUID();
      content.policy = artifact.policy;
      content.skeleton = artifact.skeleton;
      content.anchor = artifact.anchor;
    } else {
      content = raw;
    }
    plans = [{ userId: USER_ID, planId: String(content.master_plan_id ?? USER_ID), content }];
    console.log(`[dry] prod 无 active v3 行 → 用 ${contentPath} 内存构造 content 走同一判定函数`);
  }
  console.log(`[dry] active v3 计划 ${plans.length} 个：${plans.map((plan) => `${plan.userId.slice(0, 8)}…(row ${plan.planId.slice(0, 8)}…)`).join(" ")}`);

  // ② 逐用户判定 + 一致性断言 + 判定表。
  const table: Array<Record<string, unknown>> = [];
  const judgments = [];
  for (const plan of plans) {
    const weeklyRows = (await store.listWeeklyPlanWeekStarts(plan.userId, String(plan.content.master_plan_id ?? plan.planId))).map((week_start) => ({
      week_start,
      master_plan_id: String(plan.content.master_plan_id ?? plan.planId),
      revision: 1,
    }));
    const rawDoc = await store.getWeeklyPlan(plan.userId, eventWeek);
    // Go 落库剥掉 schema/week_name——storedWeeklyDocOf 按行身份回填后严格 parse。
    const eventWeekDoc = rawDoc === null ? null : storedWeeklyDocOf(rawDoc, eventWeek);
    const activities = await store.getActivitySummariesByDateRange(plan.userId, eventWeek, addDays(eventWeek, 6));
    const context = { weeklyRows, eventWeekDoc, eventWeekActivities: toScanActivityRefs(activities) };
    const decision = judgeUserScan({ plan, context, asOf });
    assert.ok(
      assertDecisionConsistent(decision, { plan, context, asOf }),
      `${plan.userId} 判定输出与 computeRollingWindow/assessWeek 直调不一致`,
    );
    judgments.push({ plan, context, decision });
    table.push({
      user: plan.userId,
      currentW: decision.currentWeek,
      lastGen: decision.lastGeneratedWeek,
      rolling: decision.rollingWindow === null ? `no_op（${decision.rollingNote.slice(0, 40)}…）` : `W${decision.rollingWindow.startWeek}-W${decision.rollingWindow.endWeek} ${decision.rollingWindow.mode}`,
      deviation: decision.deviation === null ? `跳过（${decision.deviationNote.slice(0, 30)}…）` : `${decision.deviation.class}@${decision.deviation.weekStart}（preselect=${decision.deviation.preselect}，${decision.deviation.evidence.slice(0, 40)}…）`,
      enqueued: decision.actions.length === 0 ? "-" : decision.actions.map((action) => action.idempotencyKey).join(","),
    });
  }
  printJudgmentTable(table);
  // dry-run 断言：每个用户都有明确判定（滚动窗或 no_op 原因），偏差周带 preselect。
  for (const { decision } of judgments) {
    assert.ok(decision.rollingWindow !== null || decision.rollingNote.length > 0, "滚动侧必须有窗口或 no_op 原因");
    if (decision.deviation !== null && decision.deviation.class !== "within_tolerance") {
      assert.ok(decision.deviation.preselect !== null, "偏差周必须有 preselect");
    }
  }
  if (process.env.ROLL_DUMP) {
    await writeFile(process.env.ROLL_DUMP, JSON.stringify(judgments.map(({ decision }) => decision), null, 1));
    console.log(`dumped -> ${process.env.ROLL_DUMP}`);
  }
  console.log("[dry] 判定一致性断言全过 ✅");
}

// ── APPLY=1（LLM e2e）────────────────────────────────────────────────────────

/** 一次性 docker mysql（127.0.0.1:13307）；返回清理函数（模式照 test_rolling_e2e）。 */
async function startEphemeralMysql(): Promise<{ dsn: string; cleanup: () => Promise<void> }> {
  const container = `scan-e2e-mysql-${Date.now()}`;
  console.log(`[db] 起一次性 docker mysql：${container}（127.0.0.1:13307，用完即删）`);
  await run("docker", ["run", "-d", "--name", container, "-p", "13307:3306", "-e", "MYSQL_ROOT_PASSWORD=stride", "-e", "MYSQL_DATABASE=stride", "mysql:8"]);
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await run("docker", ["exec", container, "mysqladmin", "ping", "-h", "127.0.0.1", "-uroot", "-pstride"]);
      break;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`docker mysql 未在 120s 内就绪：${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
  return {
    dsn: "root:stride@tcp(127.0.0.1:13307)/stride?charset=utf8mb4",
    cleanup: async () => {
      if (process.env.SCAN_KEEP_DB === "1") {
        console.log(`[db] SCAN_KEEP_DB=1，保留容器 ${container} 排查`);
        return;
      }
      await run("docker", ["rm", "-f", container]).catch(() => undefined);
      console.log(`[db] 容器 ${container} 已删除`);
    },
  };
}

/** 仓库根（含 src/go/go.mod 的目录）。 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, "src/go/go.mod"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root (src/go/go.mod) not found from script location");
}

/** Go 集成测试直跑 adjustment upsert（env 门控；证据写 outPath）。 */
async function runGoAdjustmentE2e(dsn: string, upsertPath: string, outPath: string): Promise<void> {
  const { stdout, stderr } = await run(
    "go",
    ["test", "./internal/api/", "-run", "TestRollingE2EAdjustmentPendingRealPayload", "-count=1", "-v"],
    { cwd: join(repoRoot(), "src/go"), env: { ...process.env, STRIDE_ROLL_E2E_DSN: dsn, STRIDE_SCAN_E2E_UPSERT: upsertPath, STRIDE_SCAN_E2E_OUT: outPath } },
  );
  process.stdout.write(
    stdout
      .split("\n")
      .filter((line) => /RUN|PASS|FAIL|ok\s|adjust|pending/i.test(line))
      .join("\n") + "\n",
  );
  if (stderr.length > 0) console.warn(stderr.slice(0, 2_000));
}

async function applyE2e(): Promise<void> {
  const { MasterPlanGraphRequest } = await import("@stride/contract");
  const nowIso = new Date().toISOString();
  const shiftedAsOf = addDays(shanghaiDay(nowIso), -SHIFT_DAYS);
  const raceDate = process.env.SCAN_RACE_DATE ?? addDays(shiftedAsOf, 18 * 7 - 1);
  const request = MasterPlanGraphRequest.parse({
    request_id: `scan-e2e-${Date.now()}`,
    requested_mode: "new_season",
    requested_modifiers: [],
    goals: [{ race_name: "扫描验收马拉松", distance: "FM", race_date: raceDate, target_time: process.env.SCAN_TARGET ?? "2:50:00", finish_only: false, priority: "A" }],
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

  // ── ① master 生成（asOf 前移 SHIFT_DAYS）→ 首批周文档（内存物化）──
  const llmModels = createMasterPlanLlmModels({
    masterPlanModel: getAgentConfig(config, "master_plan"),
    phasingModel: getAgentConfig(config, "phasing"),
    contentModel: getAgentConfig(config, "master_plan"),
  });
  const graph = createMasterPlanGraph({ contextProvider: provider, ...llmModels });
  console.log(`[e2e] master 生成 as_of=${shiftedAsOf} race=${raceDate}`);
  const invokeMaster = async () => graph.invoke({ request }, { context: { userId: USER_ID, generationId: `scan-e2e-${Date.now()}` } });
  // LLM 失败重试一次：异常与 failed_quality_gate（goal_assessment 偶发不过契约）都算失败。
  let result = await withOneRetry("e2e-master", invokeMaster);
  if (result.outcome.decision !== "completed") {
    console.warn(`[e2e-master] 决策 ${result.outcome.decision}，重试一次`);
    result = await invokeMaster();
  }
  assert.equal(result.outcome.decision, "completed", `master 未完成：${JSON.stringify(result.outcome).slice(0, 300)}`);
  const artifact = result.outcome.artifact;
  const weeklyDocs: WeeklyPlan[] = artifact.weekly_docs ?? [];
  console.log(`[e2e] 首批 ${weeklyDocs.length} 周文档：${weeklyDocs.map((doc) => `W${doc.week_index}`).join(" ")}`);
  assert.ok(weeklyDocs.length >= 1, "首批至少 1 周文档");

  // ── ② 构造 content + 周行 → 扫描判定函数 ──
  const masterPlanId = randomUUID();
  const content = masterPlanToContent(artifact.plan, "11111111-2222-3333-4444-555555555555", { weekly_run_days_max: request.availability.weekly_run_days_max });
  content.master_plan_id = masterPlanId;
  content.policy = artifact.policy;
  content.skeleton = artifact.skeleton;
  content.anchor = artifact.anchor;
  const plan: ScanPlanRef = { userId: USER_ID, planId: "11111111-2222-3333-4444-555555555555", content };
  const weeklyRows = weeklyDocs.map((doc) => ({ week_start: doc.week_name.slice(0, 10), master_plan_id: masterPlanId, revision: 1 }));
  const eventWeek = addDays(mondayOnOrBefore(shanghaiDay(nowIso)), -7);
  const eventDoc = weeklyDocs.find((doc) => doc.week_name.slice(0, 10) === eventWeek) ?? null;
  const summaries = await store.getActivitySummariesByDateRange(USER_ID, eventWeek, addDays(eventWeek, 6));
  const context = { weeklyRows, eventWeekDoc: eventDoc, eventWeekActivities: toScanActivityRefs(summaries) };
  const decision = judgeUserScan({ plan, context, asOf: nowIso });
  console.log(
    `[e2e] 判定：currentWeek=${decision.currentWeek} lastGenerated=${decision.lastGeneratedWeek}；滚动=${decision.rollingWindow === null ? `no_op（${decision.rollingNote.slice(0, 50)}…）` : `W${decision.rollingWindow.startWeek}-W${decision.rollingWindow.endWeek} ${decision.rollingWindow.mode}`}；偏差=${decision.deviation === null ? `跳过（${decision.deviationNote.slice(0, 40)}…）` : `${decision.deviation.class}@${decision.deviation.weekStart}`}`,
  );
  assert.ok(assertDecisionConsistent(decision, { plan, context, asOf: nowIso }), "判定输出与 computeRollingWindow/assessWeek 直调不一致");
  assert.ok(decision.actions.length > 0, "e2e 断言：判定输出必须含滚动窗或偏差事件（至少一个 enqueue 动作）");

  // ── ③ 偏差事件：若无（真实周贴计划或事件周不在首批），注入合成偏差驱动 adjust 路径 ──
  let adjustAction = decision.actions.find((action) => action.kind === "adjust");
  let deviation: WeekDeviation;
  const adjustEventDoc = eventDoc ?? weeklyDocs.at(-1)!;
  const adjustEventWeek = adjustEventDoc.week_name.slice(0, 10);
  deviation = assessWeek({ weekDoc: adjustEventDoc, activities: context.eventWeekActivities });
  if (adjustAction === undefined || deviation.class === "within_tolerance") {
    deviation = {
      ...deviation,
      class: "volume_short",
      preselect: "volume_unmet",
      severe: false,
      evidence: `${deviation.evidence}；（注入合成偏差：量没练完场景驱动 create_pending 建行验收）`,
    };
    console.log(`[e2e] 事件周 ${adjustEventWeek} 在容忍内/不可检测 → 注入 volume_short/volume_unmet 合成偏差`);
  }
  const reason = (deviation.preselect ?? "volume_unmet") as AskReason;

  // ── ④ generate_adjustment handler（create_pending 路径，fake channel 断言 upsert）──
  const upsertCalls: Array<{ userId: string; masterPlanId: string; eventWeekStart: string; reason: string; question: string; payload: string }> = [];
  const adjustDeps: AdjustHandlerDeps = {
    contextProvider: provider,
    models: llmModels,
    masterPlans: {
      async getMasterPlanMetadataForDate() {
        return { planId: plan.planId, revision: 1, status: "active" as const, content };
      },
    },
    weeklyPlans: {
      async listWeeklyPlanWeeks() {
        return weeklyRows;
      },
      async getPendingAdjustment() {
        return null; // 夜检：无 pending 行 → create_pending 建行
      },
      async upsertAdjustment(userId: string, input: { masterPlanId: string; eventWeekStart: string; reason: string; question: string; payload: string }) {
        upsertCalls.push({ userId, ...input });
        return {
          id: "adj-e2e-1", master_plan_id: input.masterPlanId, event_week_start: input.eventWeekStart,
          reason: input.reason, status: "pending", payload: input.payload, question: input.question,
        };
      },
      async completeAdjustmentPayload() {
        throw new Error("create_pending 路径不走回填");
      },
      async batchApplyWeeklyPlans() {
        throw new Error("adjust job never batch-applies");
      },
    },
    weeklyDocs: {
      async getWeeklyPlan(_userId: string, weekStart: string) {
        return weeklyDocs.find((doc) => doc.week_name.slice(0, 10) === weekStart) ?? null;
      },
    },
    // projection 缺省 = 真内核 runAdjustProjection（真 LLM）
  };
  const adjustJob = {
    jobId: "job-adjust-e2e",
    userId: USER_ID,
    jobType: "generate_adjustment" as const,
    status: "queued" as const,
    attempts: 0,
    stage: "",
    progressPct: 0,
    inputJson: JSON.stringify({
      request_id: `scan-adjust-${Date.now()}`,
      master_plan_id: masterPlanId,
      event_week_start: adjustEventWeek,
      reason,
      create_pending: true,
      as_of: nowIso,
    }),
    resultJson: null,
    errorCode: null,
    errorMessage: null,
    idempotencyKey: `adjust:${USER_ID}:${adjustEventWeek}:${shanghaiDay(nowIso).replaceAll("-", "")}`,
    heartbeatAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
  };
  console.log(`[e2e] generate_adjustment（create_pending）reason=${reason} 事件周=${adjustEventWeek}（真 LLM 投影）`);
  const handlerResult = await withOneRetry("e2e-adjust", () => createAdjustJobHandler(adjustDeps)(adjustJob, async () => {}));
  const parsed = JSON.parse(handlerResult.result) as { decision: string; created_pending?: boolean; audit_summary?: { pass: number; warn: number; fail: number } };
  console.log(`[e2e] handler decision=${parsed.decision} created_pending=${String(parsed.created_pending)} audit=${parsed.audit_summary ? `${parsed.audit_summary.pass}✅${parsed.audit_summary.warn}⚠️${parsed.audit_summary.fail}❌` : "-"}`);
  assert.equal(parsed.decision, "completed");
  assert.equal(parsed.created_pending, true);
  assert.equal(upsertCalls.length, 1, "create_pending 必须经 upsertAdjustment 建行");
  const upsert = upsertCalls[0]!;
  assert.equal(upsert.eventWeekStart, adjustEventWeek);
  assert.equal(upsert.reason, reason);
  assert.equal(upsert.question, "上周完成得不理想，主要是？");
  const payload = JSON.parse(upsert.payload) as { weekly_docs: WeeklyPlan[]; evidence: string; diff: unknown[]; window: { start_week: number; end_week: number } };
  assert.ok(payload.weekly_docs.length >= 1, "payload.weekly_docs 非空");
  assert.ok(payload.weekly_docs.every((doc) => (doc.week_index ?? 0) >= payload.window.start_week && (doc.week_index ?? 0) <= payload.window.end_week), "payload 周文档都在窗口内");
  assert.ok(payload.evidence.length > 0 && payload.diff.length > 0, "payload 带证据与 diff");
  console.log(`[e2e] payload 完整：${payload.weekly_docs.length} 周文档（W${payload.window.start_week}-W${payload.window.end_week}），${payload.evidence.slice(0, 50)}…`);

  // ── ⑤ upsert 产物交 Go e2e（docker mysql）断言 pending 行建立 + payload 落库 ──
  const workDir = await mkdtemp(join(tmpdir(), "scan-e2e-"));
  try {
    const upsertPath = join(workDir, "upsert.json");
    const outPath = join(workDir, "result.json");
    await writeFile(upsertPath, JSON.stringify({ user_id: randomUUID(), master_plan_id: masterPlanId, event_week_start: adjustEventWeek, reason, question: upsert.question, payload: upsert.payload }));
    let dsn = process.env.STRIDE_ROLL_E2E_DSN ?? "";
    let db: { cleanup: () => Promise<void> } | null = null;
    if (dsn === "") {
      const ephemeral = await startEphemeralMysql();
      db = ephemeral;
      dsn = ephemeral.dsn;
    }
    try {
      await withOneRetry("e2e-go-upsert", () => runGoAdjustmentE2e(dsn, upsertPath, outPath));
      const evidence = JSON.parse(await readFile(outPath, "utf8")) as { adjustment_id: string; payload_bytes: number; stale_superseded: string; closed_reupsert: number };
      console.log(`[e2e] Go 落库证据：pending 行 ${evidence.adjustment_id.slice(0, 8)}…（payload ${evidence.payload_bytes}B 原样落库；旧 pending → ${evidence.stale_superseded}；关闭后重投 HTTP ${evidence.closed_reupsert}）`);
      assert.equal(evidence.stale_superseded, "superseded");
      assert.equal(evidence.closed_reupsert, 409);
      console.log("[e2e] 端到端断言全过 ✅");
    } finally {
      await db?.cleanup();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  void adjustAction;
}

async function main(): Promise<void> {
  try {
    if (APPLY) {
      await applyE2e();
    } else {
      await dryRun();
    }
  } finally {
    await store.close();
  }
}

void main().catch((error) => {
  console.error("[scan] 失败：", error);
  process.exit(1);
});
