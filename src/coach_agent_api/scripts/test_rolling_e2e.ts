import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createMasterPlanGraph,
  createMasterPlanLlmModels,
  DataProviderMasterPlanContextProvider,
  fromStoredContent,
  getAgentConfig,
  loadConfig,
  masterPlanToContent,
  MasterPlanGraphRequest,
  runRollingProjection,
} from "@stride/coach-agent";
import { addDays, mondayOnOrBefore, shanghaiDay } from "@stride/contract";
import { MySqlDataProvider } from "@stride/coach-agent-worker";
import assert from "node:assert/strict";
import { loadApiConfig } from "../src/config.js";
import { coachAgentConfigFiles, coachApiConfigFiles } from "../src/configPaths.js";

/**
 * 滚动内核端到端验收（#858 PR-A Round 2，模式同 test_rolling.ts：prod 只读 +
 * 真模型；**写操作全部打向本地/一次性 docker MySQL，不碰生产库**）：
 *   ① master 生成（requested_as_of=现在−35 天的周一，目标 2:50，18 周跑道）→
 *      artifact.weekly_docs 首批 3-6 周文档
 *   ② fromStoredContent(masterPlanToContent 同构 content) 解析成功
 *   ③ 落库验证：env 门控 Go 集成测试直跑 batch-apply（首批 N 周插入 → 同批重投
 *      revision+1 不重复 → list 过滤 master_plan_id），证据写回 /tmp 由脚本打印
 *   ④ runRollingProjection(asOf=现在) 在「list 喂了首批周」的 lastGeneratedWeek
 *      下批窗正确（boundary 触发下一块，跑通 completed 即可）
 * DB 选择：STRIDE_ROLL_E2E_DSN 显式给 → 直接用；否则起一次性 docker mysql
 * （127.0.0.1:13307，容器用完即删；STRIDE_ROLL_E2E_KEEP_DB=1 保留排查）。
 * env：ROLL_TARGET（缺省 2:50:00）/ ROLL_SHIFT_DAYS（缺省 35）/ ROLL_RUNWAY_WEEKS（18）。
 */

const run = promisify(execFile);

type Profile = "local" | "prod";
const PROFILE = "prod" as Profile;
process.env.STRIDE_COACH_ENV = PROFILE;
const USER_ID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
const GOAL_ID = "11111111-2222-3333-4444-555555555555";

const TARGET_TIME = process.env.ROLL_TARGET ?? "2:50:00";
const SHIFT_DAYS = Number(process.env.ROLL_SHIFT_DAYS ?? 35);
const RUNWAY_WEEKS = Number(process.env.ROLL_RUNWAY_WEEKS ?? 18);

export const config = loadConfig({ configFiles: coachAgentConfigFiles(import.meta.url) });
const modelConfig = getAgentConfig(config, "master_plan");
const phasingConfig = getAgentConfig(config, "phasing");

const store = MySqlDataProvider.create(loadApiConfig({ configFiles: coachApiConfigFiles(import.meta.url) }).strideDatabase);
const provider = new DataProviderMasterPlanContextProvider(store);

const shiftedMonday = mondayOnOrBefore(shanghaiDay(new Date(Date.now() - SHIFT_DAYS * 86_400_000).toISOString()));
const raceDate = process.env.MP_RACE_DATE ?? addDays(shiftedMonday, RUNWAY_WEEKS * 7 - 1);
const nowIso = new Date().toISOString();

const request = MasterPlanGraphRequest.parse({
  request_id: `rolling-e2e-${Date.now()}`,
  requested_mode: "new_season",
  requested_modifiers: [],
  goals: [
    {
      race_name: "滚动落库验收马拉松",
      location: null,
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

/** LLM 真调用失败先重试一次再报告（约定：最多两次尝试）。 */
async function withOneRetry<T>(label: string, attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    console.warn(`[${label}] 第一次尝试失败，重试一次：${error instanceof Error ? error.message : String(error)}`);
    return await attempt();
  }
}

/** 一次性 docker mysql（127.0.0.1:13307）；返回容器名，调用方负责清理。 */
async function startEphemeralMysql(): Promise<{ container: string; dsn: string; cleanup: () => Promise<void> }> {
  const container = `roll-e2e-mysql-${Date.now()}`;
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
  const cleanup = async () => {
    if (process.env.STRIDE_ROLL_E2E_KEEP_DB === "1") {
      console.log(`[db] STRIDE_ROLL_E2E_KEEP_DB=1，保留容器 ${container} 排查`);
      return;
    }
    await run("docker", ["rm", "-f", container]).catch(() => undefined);
    console.log(`[db] 容器 ${container} 已删除`);
  };
  return { container, dsn: "root:stride@tcp(127.0.0.1:13307)/stride?charset=utf8mb4", cleanup };
}

/** 仓库根（含 src/go/go.mod 的目录）——src 与 dist 运行位置都兼容。 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, "src/go/go.mod"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root (src/go/go.mod) not found from script location");
}

/** Go 集成测试直跑 batch-apply/list（env 门控；证据写 outPath）。 */
async function runGoMaterialization(dsn: string, docsPath: string, outPath: string): Promise<void> {
  const { stdout, stderr } = await run("go", ["test", "./internal/api/", "-run", "TestRollingE2EBatchApplyRealDocs", "-count=1", "-v"], {
    cwd: join(repoRoot(), "src/go"),
    env: { ...process.env, STRIDE_ROLL_E2E_DSN: dsn, STRIDE_ROLL_E2E_DOCS: docsPath, STRIDE_ROLL_E2E_OUT: outPath },
  });
  const lines = stdout.split("\n").filter((line) => /RUN|PASS|FAIL|ok\s|rolling/i.test(line));
  process.stdout.write(lines.join("\n") + "\n");
  if (stderr.length > 0) console.warn(stderr.slice(0, 2_000));
}

async function main(): Promise<void> {
  const llmModels = createMasterPlanLlmModels({ masterPlanModel: modelConfig, phasingModel: phasingConfig, contentModel: modelConfig });
  const workDir = await mkdtemp(join(tmpdir(), "roll-e2e-"));
  let db: { cleanup: () => Promise<void> } | null = null;
  try {
    // ── 第一步：master 生成 → artifact.weekly_docs（首批物化的数据源） ──
    const graph = createMasterPlanGraph({ contextProvider: provider, ...llmModels });
    const result = await withOneRetry("step1-master", () =>
      graph.invoke({ request }, { context: { userId: USER_ID, generationId: `rolling-e2e-${PROFILE}-${Date.now()}` } }),
    );
    assert.equal(result.outcome.decision, "completed", `master 未完成：${JSON.stringify(result.outcome).slice(0, 500)}`);
    const artifact = result.outcome.artifact;
    const firstPhaseEnd = artifact.policy.phases.reduce((min, phase) => Math.min(min, phase.end_week), Number.POSITIVE_INFINITY);
    const expectedFirstBatch = Math.min(firstPhaseEnd, 6);
    const weeklyDocs = artifact.weekly_docs ?? [];
    console.log(
      `[step1] phases=${artifact.policy.phases.map((phase) => `${phase.canonical}W${phase.start_week}-${phase.end_week}`).join(" ")} totalWeeks=${artifact.plan.total_weeks}`,
    );
    console.log(`[step1] weekly_docs=${weeklyDocs.length} 周（期望=min(首阶段末周,6)=${expectedFirstBatch}）：${weeklyDocs.map((doc) => `W${doc.week_index}(${doc.phase_name})`).join(" ")}`);
    assert.ok(weeklyDocs.length >= 3 && weeklyDocs.length <= 6, `首批应为 3-6 周文档，得到 ${weeklyDocs.length}`);
    assert.equal(weeklyDocs.length, expectedFirstBatch, "首批周数应=min(首阶段末周,6)");
    const lastGeneratedWeek = Math.max(...weeklyDocs.map((doc) => doc.week_index ?? 0));
    for (const doc of weeklyDocs) {
      const week = doc.week_index ?? 0;
      assert.ok(week >= 1, "周文档必须带 week_index");
      assert.equal(doc.week_name, `${addDays(artifact.plan.start_date, (week - 1) * 7)}_${addDays(artifact.plan.start_date, (week - 1) * 7 + 6).slice(5)}`, "周文件夹名应与计划周对齐");
    }

    // ── 第二步：worker 同构 content + fromStoredContent 解析 ──
    const masterPlanId = randomUUID();
    const content = masterPlanToContent(artifact.plan, GOAL_ID, { weekly_run_days_max: request.availability.weekly_run_days_max });
    content.master_plan_id = masterPlanId;
    content.policy = artifact.policy;
    content.skeleton = artifact.skeleton;
    content.anchor = artifact.anchor;
    content.audit = artifact.audit;
    content.warnings = artifact.warnings;
    const master = fromStoredContent({ content, masterPlanId, lastGeneratedWeek });
    assert.equal(master.planStartMonday, artifact.plan.start_date);
    assert.equal(master.lastGeneratedWeek, lastGeneratedWeek);
    console.log(`[step2] fromStoredContent 解析成功：planStart=${master.planStartMonday} lastGeneratedWeek=${master.lastGeneratedWeek} weeklyRunDaysMax=${master.availability.weeklyRunDaysMax}`);

    // ── 第三步：落库验证（本地/一次性库；Go 测试二进制直跑 batch-apply） ──
    const docsPath = join(workDir, "docs.json");
    const outPath = join(workDir, "result.json");
    await writeFile(docsPath, JSON.stringify({ user_id: USER_ID, master_plan_id: masterPlanId, weeks: weeklyDocs }));
    let dsn = process.env.STRIDE_ROLL_E2E_DSN ?? "";
    if (dsn === "") {
      const ephemeral = await startEphemeralMysql();
      db = ephemeral;
      dsn = ephemeral.dsn;
    }
    await withOneRetry("step3-materialize", () => runGoMaterialization(dsn, docsPath, outPath));
    const evidence = JSON.parse(await readFile(outPath, "utf8")) as {
      weeks_sent: number;
      listed: Array<{ week_start: string; revision: number }>;
      applied_first: Array<{ revision: number }>;
      applied_again: Array<{ revision: number; replaced: boolean }>;
      workout_rows: number;
    };
    assert.equal(evidence.weeks_sent, weeklyDocs.length);
    assert.equal(evidence.listed.length, weeklyDocs.length, "list 应返回 N 周");
    assert.ok(evidence.listed.every((row) => row.revision === 2), "同批重投后 revision 应为 2");
    assert.ok(evidence.applied_first.every((row) => row.revision === 1));
    assert.ok(evidence.applied_again.every((row) => row.revision === 2 && row.replaced), "重投应为期望替换 revision+1");
    console.log(`[step3] 落库证据（list 输出，oldest first，重投后）：`);
    for (const row of evidence.listed) console.log(`[step3]   ${row.week_start} revision=${row.revision}`);
    console.log(`[step3] workout 物化行=${evidence.workout_rows}；首批 ${evidence.weeks_sent} 周 → 重投 revision 1→2，行数不重复 ✅`);
    const adoption = (evidence as { adoption?: { adopted_plan_id: string; current_plan_id: string; weeks_after_apply: number } }).adoption;
    assert.ok(adoption, "e2e 集成测试应产出收养证据");
    console.log(
      `[step3] apply 收养对齐：master_plan.plan_id=${adoption!.adopted_plan_id}（== weekly 归链 id ${masterPlanId.slice(0, 8)}…），apply 后 list 同 id 下 ${adoption!.weeks_after_apply} 周可见 ✅`,
    );
    assert.equal(adoption!.adopted_plan_id, masterPlanId);
    assert.equal(adoption!.current_plan_id, masterPlanId);
    assert.equal(adoption!.weeks_after_apply, weeklyDocs.length);

    // ── 第四步：滚动投影（list 喂了首批周的 lastGeneratedWeek 下）批窗正确 ──
    const outcome = await withOneRetry("step4-rolling", () => runRollingProjection({ contextProvider: provider, models: llmModels }, { userId: USER_ID, master, asOf: nowIso }));
    console.log(`[step4] decision=${outcome.decision}`);
    if (outcome.decision === "infeasible") {
      console.error(`[step4] infeasible：${outcome.reason}`);
      for (const check of outcome.failedChecks) console.error(`  ✗ ${check.id}: ${check.detail}`);
      process.exit(1);
    }
    assert.equal(outcome.decision, "completed", `step4 期望 completed：${JSON.stringify(outcome).slice(0, 400)}`);
    if (outcome.decision === "completed") {
      const currentWeek = Math.floor((Date.parse(`${mondayOnOrBefore(shanghaiDay(nowIso))}T00:00:00Z`) - Date.parse(`${master.planStartMonday}T00:00:00Z`)) / (7 * 86_400_000)) + 1;
      console.log(`[step4] window=[${outcome.window.startWeek},${outcome.window.endWeek}] mode=${outcome.window.mode}（currentWeek=${currentWeek}, lastGeneratedWeek=${master.lastGeneratedWeek}）— ${outcome.window.reason}`);
      console.log(`[step4] weeklyDocs=${outcome.weeklyDocs.length} 周：${outcome.weeklyDocs.map((doc) => `W${doc.week_index}`).join(" ")}；audit ✅${outcome.audit.summary.pass} ⚠️${outcome.audit.summary.warn} ❌${outcome.audit.summary.fail}`);
      // 批窗不变量（boundary 与 catch_up 通吃）：起点= max(存量末周+1, 当前周)——
      // 既不与已生成周重叠，也不回补已过的周（首批阶段周数随 LLM 输出浮动，
      // currentWeek 越过存量末周时是掉队追赶）。
      assert.ok(outcome.window.startWeek >= master.lastGeneratedWeek + 1, `批窗起点 ${outcome.window.startWeek} 不得早于存量末周+1（${master.lastGeneratedWeek + 1}）`);
      assert.ok(outcome.window.startWeek >= currentWeek, `批窗起点 ${outcome.window.startWeek} 不得早于当前周 ${currentWeek}（追赶不回补）`);
      assert.ok(outcome.window.endWeek >= outcome.window.startWeek, "批窗有效");
    }

    console.log("[rolling-e2e] 四步断言全过 ✅");
  } finally {
    await db?.cleanup().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    await store.close();
  }
}

await main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
