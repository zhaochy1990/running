import assert from "node:assert/strict";
import test from "node:test";
import { computeRollingWindow, RunnerSnapshotSchema, runRollingProjection } from "@stride/coach-agent";
import { addDays, WeeklyPlanSchema } from "@stride/contract";
import { type GenerateDeps, generateArtifact } from "../../src/eval/generate.js";
import { SnapshotDataProvider, SnapshotNotCoveredError } from "../../src/eval/snapshotDataProvider.js";
import { RUNNER_ID, rollingSnapshot, weekDoc } from "./fixtures.js";

const asOf = "2026-10-26T08:00:00+08:00";
const planId = "plan-eval-season";
const models = {
  goalAssessmentModel: {
    invoke: async () => {
      throw new Error("rolling never runs goal assessment");
    },
  },
  phasingModel: {
    invoke: async () => {
      throw new Error("rolling must not re-run L2");
    },
  },
  contentModel: {
    invoke: async () => {
      throw new Error("use deterministic workout fallback");
    },
  },
};

function input(snapshot = rollingSnapshot(4)) {
  return { artifact_type: "weekly_plan_batch" as const, request: { request_id: "eval-rolling", master_plan_id: planId }, snapshot, as_of: asOf };
}
const deps: GenerateDeps = {
  buildGraph: () => {
    throw new Error("rolling must not build a master graph");
  },
  buildModels: () => models,
};

for (const [lastWeek, expected, event] of [
  [4, 5, "FM"],
  [2, 4, "FM"],
  [4, 5, "HM"],
] as const) {
  test(`${event} frozen week ${lastWeek} derives start week ${expected}, not the check expectation`, async () => {
    const snapshot = rollingSnapshot(lastWeek, event);
    const result = await generateArtifact(
      input(snapshot),
      {
        ...deps,
        rollingProjection: async (projectionDeps, request) => {
          assert.equal(request.userId, RUNNER_ID);
          assert.equal(request.asOf, asOf);
          assert.equal(request.master.lastGeneratedWeek, lastWeek);
          assert.equal(request.master.race.distance, event);
          assert.equal(request.master.race.targetTime, event === "HM" ? "1:20:00" : "2:55:00");
          const window = computeRollingWindow({
            skeleton: request.master.skeleton,
            planStartMonday: request.master.planStartMonday,
            lastGeneratedWeek: request.master.lastGeneratedWeek,
            asOf: request.asOf,
          });
          assert.equal(window?.startWeek, expected);
          assert.ok(window);
          assert.deepEqual(
            await projectionDeps.existingWeeklyDoc?.(addDays("2026-10-05", (expected - 2) * 7)),
            snapshot.records.weekly_plans?.find((row) => row.week_start === addDays("2026-10-05", (expected - 2) * 7))?.content ?? null,
          );
          return {
            decision: "completed",
            window,
            weeklyDocs: Array.from({ length: window.endWeek - window.startWeek + 1 }, (_, i) => weekDoc(expected + i)),
            audit: { summary: { pass: 0, warn: 0, fail: 0 }, items: [] },
            scheduled: { source: "llm" },
          } as never;
        },
      },
      async () => {},
    );
    assert.equal(result.kind, "artifact", JSON.stringify(result));
    if (result.kind !== "artifact") return;
    assert.equal(result.artifact_type, "weekly_plan_batch");
    const artifact = JSON.parse(result.content);
    assert.equal(artifact.master_plan_id, planId);
    assert.equal(artifact.window.start_week, expected);
    assert.equal(artifact.weekly_docs[0].sessions[0].date, addDays("2026-10-05", (expected - 1) * 7));
    assert.ok(WeeklyPlanSchema.safeParse(artifact.weekly_docs[0]).success);
  });
}

test("frozen scheduled rows and complete weeks remain distinct and future reads stay offline", async () => {
  const snapshot = rollingSnapshot(4);
  const provider = new SnapshotDataProvider(snapshot, RUNNER_ID, asOf);
  assert.equal((await provider.listWeeklyPlanWeeks(RUNNER_ID, planId)).length, 4);
  assert.deepEqual(await provider.listWeeklyPlanWeeks(RUNNER_ID, "other-plan"), []);
  assert.equal((await provider.getWeeklyPlan(RUNNER_ID, "2026-10-26"))?.week_name, "2026-10-26_11-01");
  await assert.rejects(provider.getWeeklyPlan("other-runner", "2026-10-26"), SnapshotNotCoveredError);
  await assert.rejects(provider.listWeeklyPlanWeeks("other-runner", planId), SnapshotNotCoveredError);
  const missing = rollingSnapshot(4);
  delete missing.records.weekly_plan_weeks;
  const result = await generateArtifact(input(missing), deps, async () => {});
  assert.ok(result.kind === "failed");
  assert.equal(result.error.code, "snapshot_not_covered");
  assert.match(result.error.message, /weekly_plan_weeks/);
  const partial = rollingSnapshot(4);
  partial.records.weekly_plans = [];
  const gap = await generateArtifact(input(partial), deps, async () => {});
  assert.ok(gap.kind === "failed");
  assert.match(gap.error.message, /complete weekly document.*2026-10-05/);
});

test("a rolling no-op, model construction failure, model failure or mismatched frozen clock is a structured Generate error", async () => {
  for (const [overrides, code] of [
    [{ rollingProjection: async () => ({ decision: "no_op" as const, reason: "not due" }) }, "kernel_rolling_no_op"],
    [
      {
        rollingProjection: async () => {
          throw new Error("model timeout");
        },
      },
      "infrastructure_failure",
    ],
    [
      { rollingProjection: async () => ({ decision: "infeasible" as const, reason: "missing evidence", failedChecks: [{ id: "evidence", detail: "gap" }] }) },
      "kernel_rolling_infeasible",
    ],
  ] as const) {
    const result = await generateArtifact(input(), { ...deps, ...overrides }, async () => {});
    assert.ok(result.kind === "failed");
    assert.equal(result.error.code, code);
  }
  const badConfig = await generateArtifact(
    input(),
    {
      ...deps,
      buildModels: () => {
        throw new Error("missing model config");
      },
    },
    async () => {},
  );
  assert.ok(badConfig.kind === "failed");
  assert.equal(badConfig.error.code, "infrastructure_failure");
  assert.match(badConfig.error.message, /missing model config/);
  const clock = await generateArtifact({ ...input(), request: { request_id: "rolling", as_of: "2026-10-27T08:00:00+08:00" } }, deps, async () => {});
  assert.ok(clock.kind === "failed");
  assert.equal(clock.error.code, "execution_input_invalid");
});

test("real rolling kernel uses only frozen records and catch-up never adds sessions before the fixed day", async () => {
  const snapshot = rollingSnapshot(2);
  snapshot.as_of_day = "2026-10-28";
  snapshot.as_of = "2026-10-28T08:00:00+08:00";
  const frozenAsOf = "2026-10-28T08:00:00+08:00";
  const template = snapshot.records.activities[0];
  assert.ok(template);
  snapshot.records.activities = Array.from({ length: 210 }, (_, offset) => {
    const day = addDays(snapshot.as_of_day, offset - 209);
    return { ...template, labelId: `frozen-${day}`, date: `${day}T07:00:00+08:00`, shanghaiDay: day, distanceM: 12000, durationS: 3600 };
  });
  const result = await generateArtifact(
    { ...input(snapshot), as_of: frozenAsOf },
    {
      ...deps,
      rollingProjection: async (projectionDeps, request) => {
        const outcome = await runRollingProjection(projectionDeps, request);
        assert.equal(outcome.decision, "completed", JSON.stringify(outcome));
        if (outcome.decision !== "completed") throw new Error("real kernel did not complete");
        assert.equal(outcome.window.startWeek, 4);
        assert.ok(outcome.weeklyDocs.length > 0);
        for (const doc of outcome.weeklyDocs) {
          assert.ok(WeeklyPlanSchema.safeParse(doc).success);
          assert.ok(doc.sessions.every((session) => session.date > snapshot.as_of_day));
        }
        return outcome;
      },
    },
    async () => {},
  );
  assert.ok(result.kind === "failed");
  assert.equal(result.error.code, "model_generation_failed");
  assert.match(result.error.message, /deterministic workout fallback/);
});

test("the snapshot rejects a complete document attached to the wrong frozen week", () => {
  const snapshot = rollingSnapshot(4);
  const docs = snapshot.records.weekly_plans;
  assert.ok(docs?.[0]);
  docs[0].week_start = "2026-11-02";
  assert.equal(RunnerSnapshotSchema.safeParse(snapshot).success, false);
});

test("real rolling data gaps keep their snapshot_not_covered code and output violations keep their reason", async () => {
  const snapshot = rollingSnapshot(4);
  delete snapshot.as_of;
  const load = snapshot.records.daily_training_load[0];
  assert.ok(load);
  snapshot.records.daily_training_load.push({ ...load, date: "2026-10-26" });
  const gap = await generateArtifact(input(snapshot), { ...deps, rollingProjection: runRollingProjection }, async () => {});
  assert.ok(gap.kind === "failed");
  assert.equal(gap.error.code, "snapshot_not_covered");
  assert.match(gap.error.message, /getDailyTrainingLoadByDateRange/);
  const invalid = await generateArtifact(
    input(),
    {
      ...deps,
      rollingProjection: async () =>
        ({ decision: "completed", scheduled: { source: "fallback", attemptsDetail: [{ violations: ["C1: week dose outside target"] }] } }) as never,
    },
    async () => {},
  );
  assert.ok(invalid.kind === "failed");
  assert.equal(invalid.error.code, "model_generation_failed");
  assert.match(invalid.error.message, /C1: week dose outside target/);
});
