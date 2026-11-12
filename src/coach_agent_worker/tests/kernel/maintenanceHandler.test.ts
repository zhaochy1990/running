import assert from "node:assert/strict";
import test from "node:test";
import { buildMaintenanceWeek, isMaintenanceWeeklyDoc, masterPlanToContent } from "@stride/coach-agent";
import { createTestCompletedOutcomeV3, createTestWeeklyPlanDoc } from "@stride/coach-agent/test-fixtures";
import { asPermanent } from "../../src/job/errors.js";
import { createMaintenanceJobHandler, type MaintenanceHandlerDeps } from "../../src/kernel/maintenance/handler.js";
import { FakePlanJobStore } from "../job/fakes.js";

/**
 * maintenance handler 单测（#858 PR-D，fake 全链）：reduced 出课 / rest·无行
 * no_op / 已有本周维持行→下周 / 重估夹取（V1 公式）/ 回写单值锚。
 * fixture：planStart=2026-08-10，skeleton 每周 65km → 维持带 [32.5, 45.5]。
 */

const USER_ID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
const ROW_PLAN_ID = "11111111-2222-3333-4444-555555555555";
const CONTENT_MASTER_ID = "99999999-8888-7777-6666-555555555555";
/** 上海日 2026-09-16（周三）→ 当前周周一 2026-09-14（第 6 周）。 */
const AS_OF = "2026-09-16T10:00:00.000+08:00";
const CURRENT_WEEK = "2026-09-14";
const NEXT_WEEK = "2026-09-21";

function storedContent(): Record<string, unknown> {
  const { artifact } = createTestCompletedOutcomeV3({ totalWeeks: 10 });
  const content = masterPlanToContent(artifact.plan, ROW_PLAN_ID, { weekly_run_days_max: 6 });
  content.master_plan_id = CONTENT_MASTER_ID;
  content.policy = artifact.policy;
  content.skeleton = artifact.skeleton;
  content.anchor = artifact.anchor;
  return content;
}

interface Harness {
  deps: MaintenanceHandlerDeps;
  applies: Array<{ masterPlanId: string; weeks: unknown[] }>;
  maintenanceWrites: number[];
}

function harness(overrides: { state?: object | null; weekDocs?: Map<string, unknown>; activityKm?: number[] } = {}): Harness {
  const applies: Array<{ masterPlanId: string; weeks: unknown[] }> = [];
  const maintenanceWrites: number[] = [];
  const state =
    overrides.state === undefined
      ? {
          master_plan_id: CONTENT_MASTER_ID,
          mode: "reduced",
          detail: "左膝髌骨酸痛",
          maintenance_km: null,
          needs_verdict: false,
          last_checkin_day: null,
          last_checkin_answer: null,
        }
      : overrides.state;
  const docs = overrides.weekDocs ?? new Map<string, unknown>();
  const deps: MaintenanceHandlerDeps = {
    contextProvider: {
      async loadActivities(_userId: string, startDay: string, _endDay: string) {
        // 近 2 完整周（2026-08-31..2026-09-13）逐日合成活动；activityKm=每日 km。
        const base = overrides.activityKm ?? [];
        const out: Array<{ shanghaiDay: string; distanceM: number | null }> = [];
        let index = 0;
        for (const day of ["2026-09-01", "2026-09-04", "2026-09-08", "2026-09-11", "2026-09-05", "2026-09-12"]) {
          if (day < startDay) continue;
          out.push({ shanghaiDay: day, distanceM: (base[index] ?? 0) * 1000 });
          index += 1;
        }
        return out as never;
      },
    },
    masterPlans: {
      async getMasterPlanMetadataForDate() {
        return { planId: ROW_PLAN_ID, revision: 1, status: "active" as const, content: storedContent() };
      },
    },
    weeklyPlans: {
      async getInjuryState() {
        return state as never;
      },
      async listWeeklyPlanWeeks() {
        return [];
      },
      async batchApplyWeeklyPlans(_userId: string, masterPlanId: string, weeks: unknown[]) {
        applies.push({ masterPlanId, weeks });
        return weeks.map((_, i) => ({ week_start: "", plan_id: `p-${i}`, revision: 1, replaced: false }));
      },
      async updateInjuryMaintenance(_userId: string, km: number) {
        maintenanceWrites.push(km);
        return { ...(state as object), maintenance_km: km } as never;
      },
      async completeAdjustmentPayload() {
        throw new Error("maintenance job never touches adjustments");
      },
      async getPendingAdjustment() {
        return null;
      },
      async upsertAdjustment() {
        throw new Error("maintenance job never upserts adjustments");
      },
    },
    weeklyDocs: {
      async getWeeklyPlan(_userId: string, weekStart: string) {
        return docs.get(weekStart) ?? null;
      },
    },
  };
  return { deps, applies, maintenanceWrites };
}

function job(masterPlanId?: string) {
  return FakePlanJobStore.fixture({
    userId: USER_ID,
    jobType: "generate_maintenance",
    inputJson: JSON.stringify({ request_id: "req-1", ...(masterPlanId ? { master_plan_id: masterPlanId } : {}), as_of: AS_OF }),
  });
}

test("无 active 伤病行（已恢复）= no_op", async () => {
  const result = await createMaintenanceJobHandler(harness({ state: null }).deps)(job(), async () => {});
  assert.equal(JSON.parse(result.result).decision, "no_op");
});

test("mode=rest 完全停 = no_op（不出维持课）", async () => {
  const result = await createMaintenanceJobHandler(harness({ state: { mode: "rest", maintenance_km: null, needs_verdict: false } }).deps)(
    job(),
    async () => {},
  );
  const parsed = JSON.parse(result.result);
  assert.equal(parsed.decision, "no_op");
  assert.match(parsed.reason, /rest/);
});

test("reduced 出课：当前周维持文档 + 重估回写单值锚", async () => {
  // 近 2 周实际：6 天活动共 (30+0+25+0+20+0)=75km → 均值 37.5；state 锚 null →
  // start=65×0.6=39 → min(40.95, 41.25)=40.95 ∈ [32.5,45.5] → 41（r1）。
  const h = harness({ activityKm: [30, 0, 25, 0, 20, 0] });
  const result = await createMaintenanceJobHandler(h.deps)(job(), async () => {});
  const parsed = JSON.parse(result.result);
  assert.equal(parsed.decision, "completed");
  assert.equal(parsed.week_start, CURRENT_WEEK);
  assert.equal(parsed.week_index, 6);
  assert.equal(parsed.maintenance_km, 41);
  assert.equal(h.applies.length, 1);
  assert.equal(h.applies[0]!.masterPlanId, CONTENT_MASTER_ID);
  const doc = h.applies[0]!.weeks[0] as { week_name: string; coach_notes: string | null; target_weekly_km_low?: number };
  assert.equal(doc.week_name.slice(0, 10), CURRENT_WEEK);
  assert.equal(isMaintenanceWeeklyDoc({ coach_notes: doc.coach_notes }), true);
  assert.equal(doc.target_weekly_km_low, 41);
  assert.deepEqual(h.maintenanceWrites, [41]);
});

test("重估夹取：低锚抬到带下沿 0.5×伤前 / 高锚压到带上沿 0.7×伤前", async () => {
  // state=20（带下 32.5 以下）且实际很少跑 → min(21, 低) → 夹到 32.5。
  const low = harness({ state: { mode: "reduced", maintenance_km: 20, needs_verdict: false }, activityKm: [5, 0, 5, 0, 5, 0] });
  const lowResult = await createMaintenanceJobHandler(low.deps)(job(), async () => {});
  assert.equal(JSON.parse(lowResult.result).maintenance_km, 32.5);
  assert.deepEqual(low.maintenanceWrites, [32.5]);

  // state=60（带上 45.5 以上），实际 45km/周 → min(63, 49.5)=49.5 → 夹到 45.5。
  const high = harness({ state: { mode: "reduced", maintenance_km: 60, needs_verdict: false }, activityKm: [45, 45, 45, 0, 0, 0] });
  const highResult = await createMaintenanceJobHandler(high.deps)(job(), async () => {});
  assert.equal(JSON.parse(highResult.result).maintenance_km, 45.5);
  assert.deepEqual(high.maintenanceWrites, [45.5]);
});

test("本周已有维持行（coach_notes 标记）→ 目标周顺延下一周", async () => {
  // Go 落库剥掉 schema/week_name——storedWeeklyDocOf 按行身份回填后严格 parse，
  // 所以 fake 行也要用真文档（buildMaintenanceWeek 产物剥壳）。
  const maintenanceRow = buildMaintenanceWeek({
    planStartMonday: "2026-08-10",
    weekStart: CURRENT_WEEK,
    weeklyRunDaysMax: 6,
    maintenanceKm: 39,
    strengthPerWeek: 2,
  });
  const existing = { ...maintenanceRow };
  delete (existing as Record<string, unknown>).schema;
  delete (existing as Record<string, unknown>).week_name;
  const h = harness({ weekDocs: new Map([[CURRENT_WEEK, existing]]) });
  const result = await createMaintenanceJobHandler(h.deps)(job(), async () => {});
  const parsed = JSON.parse(result.result);
  assert.equal(parsed.decision, "completed");
  assert.equal(parsed.week_start, NEXT_WEEK);
  assert.equal(parsed.week_index, 7);
});

test("本周已有普通滚动周行（非维持标记）→ 保留过去安排，明天起覆盖出维持课", async () => {
  const rollingRow = createTestWeeklyPlanDoc(6);
  const existing = { ...rollingRow };
  delete (existing as Record<string, unknown>).schema;
  delete (existing as Record<string, unknown>).week_name;
  const h = harness({ weekDocs: new Map([[CURRENT_WEEK, existing]]) });
  const result = await createMaintenanceJobHandler(h.deps)(job(), async () => {});
  assert.equal(JSON.parse(result.result).week_start, CURRENT_WEEK);
  assert.equal(h.applies.length, 1);
  const doc = h.applies[0]!.weeks[0] as { sessions: Array<{ date: string; summary: string }>; coach_notes: string | null };
  // #952：本周已过安排（周一旧有氧跑）逐字段保留，明天起才是维持课。
  assert.equal(doc.sessions.find((session) => session.date === CURRENT_WEEK)?.summary, "有氧跑");
  assert.equal(isMaintenanceWeeklyDoc({ coach_notes: doc.coach_notes }), true);
  assert.ok(doc.sessions.filter((session) => session.date > "2026-09-16").length > 0);
});

test("master_plan_id 不一致 = permanent error", async () => {
  await assert.rejects(
    createMaintenanceJobHandler(harness().deps)(job("00000000-0000-0000-0000-000000000001"), async () => {}),
    (error: unknown) => asPermanent(error)?.code === "kernel_maintenance_master_plan_mismatch",
  );
});
