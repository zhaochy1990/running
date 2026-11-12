/**
 * #858 PR-D 验收脚本（伤病模式后端，零 LLM 即可全跑）：
 *
 * 默认（零 LLM，prod 只读 + docker mysql 一次性）：
 *   ① prod 只读枚举 active v3 master 计划（listActiveMasterPlans；无行时
 *      SCAN_MASTER_CONTENT=<content JSON 路径> 兜底，模式照 test_scan）；
 *   ② 模拟进入减量（detail 文本 + verdict=reduced，锚=skeleton 当前周 km×0.6）
 *      → buildMaintenanceWeek 断言（schema 硬校验/天数分布/LR 上限/无质量课/
 *      coach_notes 标记/营养骨架/总量精确）；
 *   ③ 重估公式走查（V1：clamp(min(锚×1.05, 近2周实际×1.1), 0.5×伤前, 0.7×伤前)
 *      的低锚/高锚/正常三档）；
 *   ④ TS 侧状态机走查（better×2→recovered 的 needs_verdict/关行语义镜像 Go
 *      storage，逐步喂 judgeUserScan 断言 maintenance enqueue / 已有维持行不投 /
 *      rest+比赛临近 replan_suggest）；
 *   ⑤ docker mysql 一次性跑 Go injury 生命周期集成测试（真实 store + 真实
 *      HTTP 端点：enter/checkin 序列/doctor 转换/当天幂等/内部通道/履历审计，
 *      模式照 weekly_plan_rolling_e2e_test）。
 *
 * 运行：npm run build 后
 *   STRIDE_COACH_ENV=prod node dist/scripts/test_injury.js
 * env：INJURY_SKIP_DB=1（跳过 docker 阶段）、INJURY_MASTER_CONTENT/SCAN_MASTER_CONTENT
 * （content 兜底：worker 落库 content 或 master_plan_draft artifact；都没有时用仓库
 * 内置 v3 fixture（createTestCompletedOutcomeV3，planStart=2026-08-10/race=2026-10-18，
 * 判定时点自动回放 2026-09-16））、INJURY_DRY_AS_OF（判定时点回放）、INJURY_KEEP_DB=1。
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
import { buildMaintenanceWeek, currentWeekOf, fromStoredContent, isMaintenanceWeeklyDoc, loadConfig, masterPlanToContent } from "@stride/coach-agent";
import { MySqlDataProvider } from "@stride/coach-agent-worker";
import { addDays, mondayOnOrBefore, shanghaiDay, type WeeklyPlan, WeeklyPlanSchema } from "@stride/contract";
import { loadApiConfig } from "../src/config.js";
import { judgeUserScan, type ScanPlanRef } from "../src/coach/rollingScan.js";
import { coachAgentConfigFiles, coachApiConfigFiles } from "../src/configPaths.js";

const run = promisify(execFile);

type Profile = "local" | "prod";
const PROFILE = "prod" as Profile;
process.env.STRIDE_COACH_ENV = PROFILE;
const USER_ID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
const SKIP_DB = process.env.INJURY_SKIP_DB === "1";

export const config = loadConfig({ configFiles: coachAgentConfigFiles(import.meta.url) });
const store = MySqlDataProvider.create(loadApiConfig({ configFiles: coachApiConfigFiles(import.meta.url) }).strideDatabase);

const r1 = (x: number) => Math.round(x * 10) / 10;
const clamp = (x: number, low: number, high: number) => Math.min(Math.max(x, low), high);

/** 判定表打印（同 test_scan 口径）。 */
function printJudgmentTable(rows: Array<Record<string, unknown>>): void {
  const header = ["检查项", "结果"];
  console.log(`[injury] ${header.join(" | ")}`);
  for (const row of rows) {
    console.log(`[injury] ${[row.case, row.result].join(" | ")}`);
  }
}

// ── ① prod 只读：枚举 active v3 计划（兜底模式照 test_scan；两级兜底后仍可
// 用仓库内置 v3 fixture——零 LLM、确定性，prod 只读不破坏）──────────────────

async function loadPlans(): Promise<ScanPlanRef[]> {
  const plans = await store.listActiveMasterPlans();
  if (plans.length > 0) {
    console.log(`[dry] prod active v3 计划 ${plans.length} 个`);
    return plans;
  }
  const contentPath = process.env.INJURY_MASTER_CONTENT ?? process.env.SCAN_MASTER_CONTENT ?? "";
  if (contentPath === "" || !existsSync(contentPath)) {
    // 内置 v3 fixture（testFixtures 同款）：prod 无行且无兜底产物时的零 LLM 路径。
    const { createTestCompletedOutcomeV3 } = await import("@stride/coach-agent/test-fixtures");
    const { artifact } = createTestCompletedOutcomeV3({ totalWeeks: 10 });
    const content = masterPlanToContent(artifact.plan, "11111111-2222-3333-4444-555555555555", { weekly_run_days_max: 6 });
    content.master_plan_id = randomUUID();
    content.policy = artifact.policy;
    content.skeleton = artifact.skeleton;
    content.anchor = artifact.anchor;
    console.log(`[dry] prod 无 active v3 行且未设 INJURY_MASTER_CONTENT → 用内置 v3 fixture（planStart=2026-08-10，race=2026-10-18）`);
    return [{ userId: USER_ID, planId: "11111111-2222-3333-4444-555555555555", content }];
  }
  const raw = JSON.parse(await readFile(contentPath, "utf8")) as Record<string, unknown>;
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
  console.log(`[dry] prod 无 active v3 行 → 用 ${contentPath} 内存构造 content`);
  return [{ userId: USER_ID, planId: String(content.master_plan_id ?? USER_ID), content }];
}

// ── ②③④ 维持课断言 + 重估走查 + TS 状态机走查 ─────────────────────────────

/** Go storage 状态机的 TS 镜像（生命周期语义单源在 Go；此处仅为脚本走查口径）。 */
interface FakeInjuryState {
  mode: "reduced" | "rest" | "pending_doctor";
  needs_verdict: boolean;
  maintenance_km: number | null;
}
function fakeCheckin(state: FakeInjuryState, answer: "better" | "same" | "worse" | "recovered"): FakeInjuryState | null {
  if (answer === "recovered") return null; // 删 active 行（留履历）
  if (answer === "worse") return { ...state, needs_verdict: true }; // mode 不变，要求重判
  return state; // better/same 只记履历（锚不动——重估单一真源在 TS job）
}

async function dryRun(): Promise<{ masterPlanId: string; maintenanceWeek: WeeklyPlan }> {
  const plans = await loadPlans();
  // 内置 fixture 兜底时回放计划中段（第 6 周周三），prod 真行缺省=现在。
  const asOf = process.env.INJURY_DRY_AS_OF ?? (plans[0]!.content.start_date === "2026-08-10" ? "2026-09-16T10:00:00.000+08:00" : new Date().toISOString());
  const asOfDay = shanghaiDay(asOf);
  const plan = plans[0]!;
  const contentMasterId = String(plan.content.master_plan_id ?? plan.planId);
  const master = fromStoredContent({ content: plan.content, masterPlanId: contentMasterId, lastGeneratedWeek: 1 });
  const currentWeek = currentWeekOf(master.planStartMonday, asOf);
  const table: Array<Record<string, unknown>> = [];

  // ② 进入减量：锚=当前周 skeleton km×0.6（worker 缺省口径同款）。
  const skeletonWeeks = master.skeleton.weeks.filter((week) => week.km > 0).sort((a, b) => a.week - b.week);
  assert.ok(skeletonWeeks.length > 0, "skeleton 无正量周");
  const skeletonWeek = skeletonWeeks.find((week) => week.week === currentWeek) ?? skeletonWeeks.at(-1)!;
  const preInjuryKm = skeletonWeek.km;
  const maintenanceKm = r1(preInjuryKm * 0.6);
  const weekStart = mondayOnOrBefore(asOfDay);
  console.log(`[dry] 第 ${currentWeek} 周（${weekStart}）：伤前骨架 ${preInjuryKm}km → 减量锚 ${maintenanceKm}km（verdict=reduced，detail=左膝髌骨酸痛）`);

  const doc = buildMaintenanceWeek({
    planStartMonday: master.planStartMonday,
    weekStart,
    weeklyRunDaysMax: master.availability.weeklyRunDaysMax,
    maintenanceKm,
    strengthPerWeek: 2,
    phaseGoalNote: `伤前骨架第 ${skeletonWeek.week} 周（${skeletonWeek.role}）${preInjuryKm}km`,
  });
  // schema 硬校验（构造器出口已 parse；这里显式再过一遍=验收断言）
  WeeklyPlanSchema.parse(doc);
  const runs = doc.sessions.filter((session) => session.kind === "run");
  const longRun = runs.at(-1)!;
  const longKm = (longRun.total_distance_m ?? 0) / 1000;
  const totalKm = r1(runs.reduce((total, session) => total + (session.total_distance_m ?? 0) / 1000, 0));
  table.push({ case: "跑步天数 ≤ weeklyRunDaysMax", result: `${runs.length} ≤ ${master.availability.weeklyRunDaysMax}` });
  table.push({ case: "长跑上限 min(14, 25%周量)", result: `${longKm}km ≤ ${r1(Math.min(14, maintenanceKm * 0.25))}km（${longRun.date}）` });
  table.push({ case: "周量精确=锚", result: `${totalKm}km = ${maintenanceKm}km` });
  table.push({ case: "无质量课（全 E）", result: runs.every((session) => session.summary.startsWith("E 有氧")) ? "是" : "否" });
  table.push({ case: "力量保留", result: `${doc.sessions.filter((session) => session.kind === "strength").length} 节` });
  table.push({ case: "coach_notes 标记", result: isMaintenanceWeeklyDoc(doc) ? "伤病维持期✓" : "缺失✗" });
  table.push({ case: "营养骨架 7 天", result: `${doc.nutrition.length} 天` });
  table.push({ case: "week_index/phase_name", result: `W${doc.week_index}/${doc.phase_name}` });
  printJudgmentTable(table);
  assert.ok(runs.length <= master.availability.weeklyRunDaysMax && runs.length >= 1);
  assert.ok(longKm <= Math.min(14, maintenanceKm * 0.25) + 0.05);
  assert.equal(totalKm, maintenanceKm);
  assert.ok(runs.every((session) => session.summary.startsWith("E 有氧")));
  assert.ok(isMaintenanceWeeklyDoc(doc));
  assert.equal(doc.nutrition.length, 7);
  assert.equal(doc.week_index, currentWeek);
  assert.equal(doc.phase_name, "maintenance");

  // ③ 重估公式走查（V1：低锚夹下沿/高锚夹上沿/正常档带内）。
  const reestimate = (anchor: number, actualAvg: number) => r1(clamp(Math.min(anchor * 1.05, actualAvg * 1.1), preInjuryKm * 0.5, preInjuryKm * 0.7));
  const low = reestimate(preInjuryKm * 0.3, 0);
  const high = reestimate(preInjuryKm * 0.9, preInjuryKm);
  const normal = reestimate(preInjuryKm * 0.6, preInjuryKm * 0.6);
  console.log(`[dry] 重估三档：低锚(实际0)=${low}（下沿 ${r1(preInjuryKm * 0.5)}）；高锚=${high}（上沿 ${r1(preInjuryKm * 0.7)}）；正常=${normal}`);
  assert.equal(low, r1(preInjuryKm * 0.5), "低锚+零实际 → 夹到带下沿 0.5×伤前");
  assert.equal(high, r1(preInjuryKm * 0.7), "高锚 → 夹到带上沿 0.7×伤前");
  assert.ok(normal >= r1(preInjuryKm * 0.5) && normal <= r1(preInjuryKm * 0.7), "正常档在带内");

  // ④ TS 状态机走查：better×2 → recovered，逐步喂 judgeUserScan。
  const scanDay = asOfDay.replaceAll("-", "");
  let state: FakeInjuryState | null = { mode: "reduced", needs_verdict: false, maintenance_km: null };
  const maintenanceWeeks = new Set<string>();
  const seenKeys = new Set<string>();
  const steps: Array<{ answer: string; mode: string; needs_verdict: boolean; action: string }> = [];
  for (const answer of ["better", "better", "recovered"] as const) {
    const before = state;
    state = fakeCheckin(state!, answer);
    const decision = judgeUserScan({
      plan,
      context: {
        weeklyRows: [],
        eventWeekDoc: null,
        eventWeekActivities: [],
        injury: state === null ? null : { ...state, master_plan_id: contentMasterId, detail: "", last_checkin_day: null, last_checkin_answer: null },
        currentWeekMaintenance: maintenanceWeeks.has(weekStart),
      },
      asOf,
    });
    const maintenance = decision.actions.find((action) => action.kind === "maintenance");
    if (maintenance !== undefined) {
      assert.ok(!seenKeys.has(maintenance.idempotencyKey), "维持周已存在后不得重复 enqueue");
      seenKeys.add(maintenance.idempotencyKey);
      maintenanceWeeks.add(weekStart); // 模拟 worker 落库维持行
    }
    steps.push({
      answer,
      mode: state === null ? "(closed)" : state.mode,
      needs_verdict: state?.needs_verdict === true,
      action: maintenance !== undefined ? `enqueue ${maintenance.idempotencyKey}` : state === null ? "无（已恢复，回归滚动）" : "无（维持周已在）",
    });
    void before;
  }
  console.log(`[dry] 状态机走查（better×2→recovered）：`);
  for (const step of steps) console.log(`[dry]   答 ${step.answer} → mode=${step.mode} needs_verdict=${step.needs_verdict} → ${step.action}`);
  assert.equal(seenKeys.size, 1, "首晚投一次维持课，之后维持周已在不再投");
  assert.equal(steps.at(-1)!.mode, "(closed)", "recovered 关行（之后按滚动机制接回）");
  // rest + 比赛临近：replan_suggest 标记（fixture race_date 推算）
  const raceDay = master.race.date;
  const raceWeeksAway = Math.ceil((Date.parse(`${raceDay}T00:00:00Z`) - Date.parse(`${asOfDay}T00:00:00Z`)) / (7 * 86_400_000));
  const restDecision = judgeUserScan({
    plan,
    context: { weeklyRows: [], eventWeekDoc: null, eventWeekActivities: [], injury: { mode: "rest", needs_verdict: false, maintenance_km: null, master_plan_id: contentMasterId, detail: "", last_checkin_day: null, last_checkin_answer: null } },
    asOf,
  });
  console.log(`[dry] 完全停 + 比赛距今 ${raceWeeksAway} 周 → replan_suggest=${restDecision.injury?.replan_suggest}（≤4 出标记）`);
  assert.equal(restDecision.injury?.replan_suggest, raceWeeksAway >= 0 && raceWeeksAway <= 4);
  assert.equal(restDecision.actions.length, 0, "完全停不出课");
  console.log("[dry] 维持课+重估+状态机断言全过 ✅");
  return { masterPlanId: contentMasterId, maintenanceWeek: doc };
}

// ── ⑤ docker mysql 一次性：Go injury 生命周期集成测试 ──────────────────────

async function startEphemeralMysql(): Promise<{ dsn: string; cleanup: () => Promise<void> }> {
  const container = `injury-e2e-mysql-${Date.now()}`;
  console.log(`[db] 起一次性 docker mysql：${container}（127.0.0.1:13308，用完即删）`);
  await run("docker", ["run", "-d", "--name", container, "-p", "13308:3306", "-e", "MYSQL_ROOT_PASSWORD=stride", "-e", "MYSQL_DATABASE=stride", "mysql:8"]);
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
    dsn: "root:stride@tcp(127.0.0.1:13308)/stride?charset=utf8mb4",
    cleanup: async () => {
      if (process.env.INJURY_KEEP_DB === "1") {
        console.log(`[db] INJURY_KEEP_DB=1，保留容器 ${container} 排查`);
        return;
      }
      await run("docker", ["rm", "-f", container]).catch(() => undefined);
      console.log(`[db] 容器 ${container} 已删除`);
    },
  };
}

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, "src/go/go.mod"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root (src/go/go.mod) not found from script location");
}

async function runGoInjuryE2e(dsn: string, outPath: string): Promise<void> {
  const { stdout, stderr } = await run(
    "go",
    ["test", "./internal/api/", "-run", "TestInjuryLifecycleE2E", "-count=1", "-v"],
    { cwd: join(repoRoot(), "src/go"), env: { ...process.env, STRIDE_INJURY_E2E_DSN: dsn, STRIDE_INJURY_E2E_OUT: outPath } },
  );
  process.stdout.write(
    stdout
      .split("\n")
      .filter((line) => /RUN|PASS|FAIL|ok\s|injury/i.test(line))
      .join("\n") + "\n",
  );
  if (stderr.length > 0) console.warn(stderr.slice(0, 2_000));
}

interface InjuryE2eEvidence {
  user_id: string;
  steps: Array<{ step: string; code: number }>;
  history: Record<string, number>;
  final_mode: string;
  anchor_test: number;
}

async function dbPhase(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "injury-e2e-"));
  try {
    const outPath = join(workDir, "result.json");
    let dsn = process.env.STRIDE_INJURY_E2E_DSN ?? "";
    let db: { cleanup: () => Promise<void> } | null = null;
    if (dsn === "") {
      const ephemeral = await startEphemeralMysql();
      db = ephemeral;
      dsn = ephemeral.dsn;
    }
    try {
      await runGoInjuryE2e(dsn, outPath);
      const evidence = JSON.parse(await readFile(outPath, "utf8")) as InjuryE2eEvidence;
      const bad = evidence.steps.filter((step) => step.code >= 300);
      console.log(
        `[e2e] Go 生命周期证据：${evidence.steps.map((step) => `${step.step}=${step.code}`).join("，")}；履历=${JSON.stringify(evidence.history)}；final=${evidence.final_mode}`,
      );
      assert.equal(bad.length, 0, "生命周期每步都必须 2xx");
      assert.equal(evidence.final_mode, "reduced");
      assert.ok((evidence.history.verdict ?? 0) >= 3 && (evidence.history.doctor ?? 0) >= 1 && (evidence.history.daily ?? 0) >= 2, "履历三类齐全");
      console.log("[e2e] Go 生命周期断言全过 ✅");
    } finally {
      await db?.cleanup();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  try {
    await dryRun();
    if (!SKIP_DB) {
      await dbPhase();
    } else {
      console.log("[db] INJURY_SKIP_DB=1，跳过 docker 生命周期阶段");
    }
    console.log("[injury] 全部断言通过 ✅（exit 0）");
  } finally {
    await store.close();
  }
}

void main().catch((error) => {
  console.error("[injury] 失败：", error);
  process.exit(1);
});
