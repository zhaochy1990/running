import assert from "node:assert/strict";
import test from "node:test";
import { masterPlanToContent, type Activity } from "@stride/coach-agent";
import { createTestCompletedOutcomeV3, createTestWeeklyPlanDoc } from "@stride/coach-agent/test-fixtures";
import type { WeeklyPlanWeekRow } from "@stride/coach-agent-worker";
import { createApp } from "../src/app.js";
import {
  assertDecisionConsistent,
  createRollingScanRunner,
  judgeUserScan,
  type RollingScanStore,
  type ScanPlanRef,
} from "../src/coach/rollingScan.js";
import type { PlanJobsService } from "../src/routes/planJobs.js";

/**
 * 夜检扫描单测（#858 PR-C 下半）：判定函数（judgeUserScan，纯函数）+ 编排
 * （createRollingScanRunner：单用户失败不中断、幂等键含扫描日）+ 端点
 * （internal-token 鉴权、token 未配置不挂载）。fixture 用 worker 测试同款
 * createTestCompletedOutcomeV3（planStart=2026-08-10）。
 */

const USER_ID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
const ROW_PLAN_ID = "11111111-2222-3333-4444-555555555555";
const CONTENT_MASTER_ID = "99999999-8888-7777-6666-555555555555";
/** asOf=第 6 周周一：快照周全空 → lastGeneratedWeek=min(6,totalWeeks)=6 → 边界触发。 */
const AS_OF = "2026-09-14T21:00:00.000+08:00"; // 上海日 2026-09-14（扫描日 20260914）
const EVENT_WEEK = "2026-09-07"; // 最近完整周（第 5 周）

function scanPlan(totalWeeks = 10): ScanPlanRef {
  const { artifact } = createTestCompletedOutcomeV3({ totalWeeks });
  const content = masterPlanToContent(artifact.plan, ROW_PLAN_ID, { weekly_run_days_max: 6 });
  content.master_plan_id = CONTENT_MASTER_ID;
  content.policy = artifact.policy;
  content.skeleton = artifact.skeleton;
  content.anchor = artifact.anchor;
  return { userId: USER_ID, planId: ROW_PLAN_ID, content };
}

function activityFixture(day: string, overrides: Partial<Activity> = {}): Activity {
  return {
    userId: USER_ID,
    labelId: `label-${day}`,
    name: "晨跑",
    sportName: "run",
    date: new Date(`${day}T01:00:00Z`),
    shanghaiDay: day,
    distanceM: 8000,
    durationS: 2880,
    avgPaceSKm: 360,
    bestKmPace: null,
    maxPace: null,
    avgHr: null,
    maxHr: null,
    avgCadence: null,
    maxCadence: null,
    avgPower: null,
    maxPower: null,
    avgStepLenCm: null,
    ascentM: null,
    descentM: null,
    strideDose: null,
    strideSessionClass: "easy",
    temperature: null,
    humidity: null,
    feelsLike: null,
    windSpeed: null,
    sportNote: null,
    sport: "run",
    feel: null,
    feelNote: null,
    verticalOscillationMm: null,
    groundContactTimeMs: null,
    verticalRatioPct: null,
    pauses: null,
    provider: "coros",
    laps: [],
    ...overrides,
  };
}

function weekRows(...weekStarts: string[]): WeeklyPlanWeekRow[] {
  return weekStarts.map((week_start) => ({ week_start, master_plan_id: CONTENT_MASTER_ID, revision: 1 }));
}

test("判定：边界触发 → generate_rolling_block，幂等键=rolling:{userId}:{startWeek}:{yyyyMMdd}", () => {
  const plan = scanPlan();
  const decision = judgeUserScan({
    plan,
    context: { weeklyRows: [], eventWeekDoc: null, eventWeekActivities: [] },
    asOf: AS_OF,
  });
  assert.equal(decision.rollingWindow !== null, true);
  assert.equal(decision.rollingWindow?.mode, "boundary");
  assert.equal(decision.rollingWindow?.startWeek, 7);
  assert.equal(decision.actions.length, 1);
  const action = decision.actions[0]!;
  assert.equal(action.kind, "rolling");
  assert.equal(action.idempotencyKey, `rolling:${USER_ID}:7:20260914`);
  assert.equal(action.input.master_plan_id, CONTENT_MASTER_ID);
  // 偏差侧：无周行 → 不触发（note 说明）
  assert.equal(decision.deviation, null);
  assert.match(decision.deviationNote, /无已落库 weekly 行/);
  // 一致性断言：与 computeRollingWindow 直调一致
  assert.ok(
    assertDecisionConsistent(decision, {
      plan,
      context: { weeklyRows: [], eventWeekDoc: null, eventWeekActivities: [] },
      asOf: AS_OF,
    }),
  );
});

test("判定：已落库周行抬高 lastGeneratedWeek → 未到边界不触发滚动", () => {
  const decision = judgeUserScan({
    plan: scanPlan(),
    // 第 8 周已落库（2026-08-10 + 49 天）→ lastGenerated=8 > currentWeek=6 → no_op
    context: { weeklyRows: weekRows("2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"), eventWeekDoc: null, eventWeekActivities: [] },
    asOf: AS_OF,
  });
  assert.equal(decision.rollingWindow, null);
  assert.equal(decision.lastGeneratedWeek, 8);
  assert.match(decision.rollingNote, /早于最后生成周/);
  assert.equal(decision.actions.filter((action) => action.kind === "rolling").length, 0);
});

test("判定：偏差周（无活动）→ generate_adjustment 带 create_pending+preselect", () => {
  const plan = scanPlan();
  const doc = createTestWeeklyPlanDoc(5); // 2026-09-07 那周（唯一 run 课无 spec → E 课，量差侧分类）
  const decision = judgeUserScan({
    plan,
    context: { weeklyRows: weekRows(EVENT_WEEK), eventWeekDoc: doc, eventWeekActivities: [] },
    asOf: AS_OF,
  });
  // 零活动：周量 0/65 → volume_short（课齐量差），preselect=volume_unmet
  assert.equal(decision.deviation?.class, "volume_short");
  assert.equal(decision.deviation?.preselect, "volume_unmet");
  const adjust = decision.actions.find((action) => action.kind === "adjust");
  assert.ok(adjust);
  assert.equal(adjust.kind, "adjust");
  assert.equal(adjust.idempotencyKey, `adjust:${USER_ID}:2026-09-07:20260914`);
  assert.equal(adjust.input.event_week_start, EVENT_WEEK);
  assert.equal(adjust.input.reason, "volume_unmet");
  assert.equal(adjust.input.create_pending, true);
  assert.ok(assertDecisionConsistent(decision, { plan, context: { weeklyRows: weekRows(EVENT_WEEK), eventWeekDoc: doc, eventWeekActivities: [] }, asOf: AS_OF }));
});

test("判定：within_tolerance 周 → 不投调整（偏差侧跳过、滚动侧照判）", () => {
  const doc = createTestWeeklyPlanDoc(5);
  const run = doc.sessions.find((session) => session.kind === "run")!;
  const decision = judgeUserScan({
    plan: scanPlan(),
    context: {
      weeklyRows: weekRows("2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"),
      eventWeekDoc: doc,
      // 完美执行周：与计划 run 会话一一对应（adjust handler 测试同款口径）
      eventWeekActivities: [
        { day: run.date, name: run.summary, distanceKm: 8, durationS: run.total_duration_s ?? 2880, avgPaceSKm: 360, sessionClass: "easy" },
      ],
    },
    asOf: AS_OF,
  });
  assert.equal(decision.deviation?.class, "within_tolerance");
  assert.equal(decision.actions.find((action) => action.kind === "adjust"), undefined);
});

test("判定：最近完整周早于计划起点 → 偏差侧跳过", () => {
  const decision = judgeUserScan({
    plan: scanPlan(),
    context: { weeklyRows: [], eventWeekDoc: createTestWeeklyPlanDoc(5), eventWeekActivities: [] },
    asOf: "2026-08-10T21:00:00.000+08:00", // 第 1 周周一：事件周 2026-08-03 早于计划
  });
  assert.equal(decision.deviation, null);
  assert.match(decision.deviationNote, /早于计划起点/);
});

// ── 编排（fake store + fake enqueuer）─────────────────────────────────────────

interface EnqueueCall {
  userId: string;
  jobType: string;
  inputJson: string;
  idempotencyKey?: string;
}

function fakeStore(plans: ScanPlanRef[], activities: Activity[] = [], weeklyDoc: unknown | null = null): RollingScanStore {
  return {
    async listActiveMasterPlans() {
      return plans;
    },
    async getWeeklyPlan() {
      return weeklyDoc;
    },
    async getActivitySummariesByDateRange() {
      return activities;
    },
  };
}

function fakeEnqueuer(): { enqueue: PlanJobsService["enqueue"]; calls: EnqueueCall[] } {
  const calls: EnqueueCall[] = [];
  return {
    calls,
    enqueue: async (input) => {
      calls.push({ ...input });
      return { jobId: `job-${calls.length}`, estimatedDurationSeconds: 300 };
    },
  };
}

test("编排：边界+偏差同发（两 job），汇总计数与幂等键落账", async () => {
  const enqueuer = fakeEnqueuer();
  const runner = createRollingScanRunner({
    store: fakeStore([scanPlan()], [], createTestWeeklyPlanDoc(5)),
    weeklyPlans: {
      async listWeeklyPlanWeeks() {
        return weekRows(EVENT_WEEK);
      },
    },
    enqueue: enqueuer.enqueue,
  });
  const summary = await runner.runRollingScan({ asOf: AS_OF, dispatch: true });
  assert.equal(summary.scanned, 1);
  assert.equal(summary.rolling_enqueued, 1);
  assert.equal(summary.adjust_enqueued, 1);
  assert.deepEqual(summary.skipped, []);
  assert.equal(enqueuer.calls.length, 2);
  assert.equal(enqueuer.calls[0]?.jobType, "generate_rolling_block");
  assert.equal(enqueuer.calls[0]?.idempotencyKey, `rolling:${USER_ID}:7:20260914`);
  assert.equal(enqueuer.calls[1]?.jobType, "generate_adjustment");
  const adjustInput = JSON.parse(enqueuer.calls[1]!.inputJson) as { create_pending?: boolean; reason?: string };
  assert.equal(adjustInput.create_pending, true);
  assert.equal(adjustInput.reason, "volume_unmet");
  // 用户摘要带判定细节
  assert.equal(summary.users[0]?.deviation?.class, "volume_short");
});

test("编排：单用户失败跳过不中断（坏 content 记入 skipped，后续用户照跑）", async () => {
  const enqueuer = fakeEnqueuer();
  const badPlan: ScanPlanRef = { userId: "user-bad", planId: ROW_PLAN_ID, content: { total_weeks: 10 } };
  const runner = createRollingScanRunner({
    store: fakeStore([badPlan, scanPlan()], [], createTestWeeklyPlanDoc(5)),
    weeklyPlans: {
      async listWeeklyPlanWeeks() {
        return weekRows(EVENT_WEEK);
      },
    },
    enqueue: enqueuer.enqueue,
  });
  const summary = await runner.runRollingScan({ asOf: AS_OF, dispatch: true });
  assert.equal(summary.scanned, 2);
  assert.equal(summary.skipped.length, 1);
  assert.equal(summary.skipped[0]?.user_id, "user-bad");
  // 好用户照常投递
  assert.equal(summary.rolling_enqueued + summary.adjust_enqueued, 2);
});

test("编排：dispatch=false dry-run 只判定不投", async () => {
  const enqueuer = fakeEnqueuer();
  const runner = createRollingScanRunner({
    store: fakeStore([scanPlan()], [], createTestWeeklyPlanDoc(5)),
    weeklyPlans: {
      async listWeeklyPlanWeeks() {
        return weekRows(EVENT_WEEK);
      },
    },
    enqueue: enqueuer.enqueue,
  });
  const summary = await runner.runRollingScan({ asOf: AS_OF, dispatch: false });
  assert.equal(enqueuer.calls.length, 0);
  assert.equal(summary.users[0]?.enqueued.length, 0);
});

// ── 端点（internal-token 鉴权 + 未配置不挂载）────────────────────────────────

function scanApp(internalToken: string) {
  const enqueuer = fakeEnqueuer();
  const runner = createRollingScanRunner({
    store: fakeStore([scanPlan()], [], createTestWeeklyPlanDoc(5)),
    weeklyPlans: {
      async listWeeklyPlanWeeks() {
        return weekRows(EVENT_WEEK);
      },
    },
    enqueue: enqueuer.enqueue,
  });
  const app = createApp({
    jwtVerifier: {
      async verify() {
        throw new Error("rolling-scan never verifies JWTs");
      },
    },
    coachInvoker: {
      async invoke() {
        throw new Error("must not invoke coach");
      },
      streamEvents: () => {
        throw new Error("must not stream");
      },
    },
    ...(internalToken !== "" ? { rollingScan: { scan: runner, internalToken } } : {}),
  });
  return { app, enqueuer };
}

test("端点：正确 X-Internal-Token → 200 汇总；错 token/缺 token → 401；as_of 回放", async () => {
  const { app, enqueuer } = scanApp("scan-secret");
  const ok = await app.request("/api/internal/coach/rolling-scan", {
    method: "POST",
    headers: { "x-internal-token": "scan-secret", "content-type": "application/json" },
    body: JSON.stringify({ as_of: AS_OF }),
  });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { scanned: number; rolling_enqueued: number; adjust_enqueued: number };
  assert.equal(body.scanned, 1);
  assert.equal(body.rolling_enqueued, 1);
  assert.equal(body.adjust_enqueued, 1);
  assert.equal(enqueuer.calls.length, 2);

  // 非法 as_of → 400
  const badAsOf = await app.request("/api/internal/coach/rolling-scan", {
    method: "POST",
    headers: { "x-internal-token": "scan-secret", "content-type": "application/json" },
    body: JSON.stringify({ as_of: "not-a-date" }),
  });
  assert.equal(badAsOf.status, 400);

  const bad = await scanApp("scan-secret").app.request("/api/internal/coach/rolling-scan", { method: "POST", headers: { "x-internal-token": "wrong" } });
  assert.equal(bad.status, 401);
  const missing = await scanApp("scan-secret").app.request("/api/internal/coach/rolling-scan", { method: "POST" });
  assert.equal(missing.status, 401);
});

test("端点：token 未配置 → 端点不挂载（404）", async () => {
  const { app } = scanApp("");
  const response = await app.request("/api/internal/coach/rolling-scan", { method: "POST", headers: { "x-internal-token": "anything" } });
  assert.equal(response.status, 404);
});
