import assert from "node:assert/strict";
import test from "node:test";
import { DataProviderMasterPlanContextProvider, RunnerSnapshotSchema } from "@stride/coach-agent";
import { SnapshotDataProvider, SnapshotNotCoveredError } from "../../src/eval/snapshotDataProvider.js";
import { createSnapshot, createSnapshotRecords, RUNNER_ID } from "./fixtures.js";

function setup() {
  const notCovered: SnapshotNotCoveredError[] = [];
  const provider = new SnapshotDataProvider(createSnapshot(), RUNNER_ID, (error) => notCovered.push(error));
  return { provider, notCovered };
}

test("range reads stay inside the snapshot and keep the provider's ordering promises", async () => {
  const { provider, notCovered } = setup();
  const activities = await provider.getActivitiesByDateRange(RUNNER_ID, "2026-10-12", "2026-10-23");
  assert.deepEqual(
    activities.map((activity) => activity.shanghaiDay),
    ["2026-10-12", "2026-10-17", "2026-10-19", "2026-10-23"],
  );
  assert.ok(activities[0]?.date instanceof Date);
  assert.equal(activities[0]?.userId, RUNNER_ID);
  // 列表读面不带 laps，区间与明细读面一致。
  assert.deepEqual(await provider.getActivitySummariesByDateRange(RUNNER_ID, "2026-10-12", "2026-10-23"), activities);
  assert.equal((await provider.getActivityDetail(RUNNER_ID, "label-2026-10-17"))?.distanceM, 16000);
  assert.equal(await provider.getActivityDetail(RUNNER_ID, "nope"), null);
  assert.equal((await provider.getDailyTrainingLoadByDateRange(RUNNER_ID, "2026-10-17", "2026-10-23")).length, 3);
  assert.equal((await provider.getDailyRecoveryByDateRange(RUNNER_ID, "2026-10-01", "2026-10-10")).length, 2);
  assert.deepEqual(await provider.getUserInjuries(RUNNER_ID), []);
  assert.equal((await provider.getUserProfile(RUNNER_ID))?.displayName, "runner-a");
  assert.equal((await provider.getRaceTarget(RUNNER_ID))?.race_date, "2027-03-21");
  assert.equal(await provider.getSyncCoverage(RUNNER_ID), null);
  assert.equal(await provider.getMasterPlan(RUNNER_ID, "2026-10-26"), null);
  assert.deepEqual(notCovered, []);
});

test("as-of reads only hand back what was known by the asked date", async () => {
  const { provider } = setup();
  assert.deepEqual(
    (await provider.getRaceHistory(RUNNER_ID, { asOfDate: "2026-03-31" })).map((effort) => effort.date),
    ["2026-03-08"],
  );
  // 默认 4.5km 噪音地板与 limit 都照生产口径。
  assert.equal((await provider.getRaceHistory(RUNNER_ID, { asOfDate: "2026-10-23", limit: 1 })).length, 1);
  assert.deepEqual(
    (await provider.getPersonalBests(RUNNER_ID, "2026-03-31")).map((best) => best.distance),
    ["FM"],
  );
  assert.equal(await provider.getLatestRunningCalibration(RUNNER_ID, "2026-10-23"), null);
});

test("requests beyond the data cutoff are 'not covered', never an empty answer, and never fall back online", async () => {
  const { provider, notCovered } = setup();
  await assert.rejects(provider.getActivitiesByDateRange(RUNNER_ID, "2026-10-01", "2026-10-24"), SnapshotNotCoveredError);
  await assert.rejects(provider.getPersonalBests(RUNNER_ID, "2026-10-24"), SnapshotNotCoveredError);
  // 计划覆盖查询不受截止日限制：由冻结计划自己的起止日期作答。
  assert.equal(await provider.getMasterPlanMetadataForDate(RUNNER_ID, "2026-11-01"), null);
  await assert.rejects(provider.getActivitiesByDateRange("someone-else", "2026-10-01", "2026-10-23"), SnapshotNotCoveredError);
  assert.equal(notCovered.length, 3);
  assert.match(notCovered[0]!.message, /2026-10-01\.\.2026-10-24 is beyond the snapshot cutoff 2026-10-23/);
  // v1 快照不含的读面同样显式拒绝。
  for (const call of [
    () => provider.getWeeklyPlan(RUNNER_ID, "2026-10-26_11-01"),
    () => provider.getPlanSessions(RUNNER_ID, "2026-10-26", "2026-11-01"),
    () => provider.getPerformanceBaseline(RUNNER_ID, "2026-10-23"),
    () => provider.searchRaceCalendar({ asofDate: "2026-10-23" }),
    () => provider.getRaceCalendarContext(1),
    () => provider.getVendorHrvBaseline(RUNNER_ID, "2026-10-23"),
    () => provider.getWeeklyFeedbackByDateRange(RUNNER_ID, "2026-10-01", "2026-10-23"),
  ]) {
    await assert.rejects(call(), SnapshotNotCoveredError);
  }
});

test("the stock master-plan context provider builds a valid snapshot from the frozen records", async () => {
  const { provider } = setup();
  const snapshot = await new DataProviderMasterPlanContextProvider(provider).loadSnapshot(RUNNER_ID, "2026-10-23T23:59:59+08:00");
  assert.equal(snapshot.macro_history.longest_run_km, 16);
  // 生产口径：111 天窗口内每个自然周一行（有跑没跑都有），共 17 周。
  assert.equal(snapshot.recent_history.weeks.length, 17);
  // 末周 = 10-19 当周：16km + 8km。
  assert.equal(snapshot.recent_history.weeks.at(-1)?.distance_km, 24);
  assert.equal(snapshot.fitness_state.ctl, 40);
  assert.equal(snapshot.coverage.find((domain) => domain.domain === "activities")?.status, "complete");
  assert.equal(snapshot.user.id, RUNNER_ID);
});

test("the snapshot contract rejects structural drift at the import boundary", () => {
  const valid = JSON.parse(JSON.stringify(createSnapshot())) as Record<string, unknown>;
  assert.ok(RunnerSnapshotSchema.safeParse(valid).success);
  const records = createSnapshotRecords();
  assert.equal(
    RunnerSnapshotSchema.safeParse({ ...valid, records: { ...records, activities: [{ ...records.activities[0]!, shanghaiDay: "2026-13-40" }] } }).success,
    false,
  );
  assert.equal(RunnerSnapshotSchema.safeParse({ ...valid, constraints: { max_run_days_per_week: 9, no_run_days: [] } }).success, false);
  assert.equal(RunnerSnapshotSchema.safeParse({ ...valid, surprise: true }).success, false);
});
