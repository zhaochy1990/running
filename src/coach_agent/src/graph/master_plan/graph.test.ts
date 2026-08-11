import assert from "node:assert/strict";
import test from "node:test";
import {
  ContextSnapshotSchema,
  createMasterPlanGraph,
  MasterPlanGraphOutcome,
  type MasterPlanGraphContext,
} from "./index.js";
import { createTestMasterPlan, createTestRequest } from "./testFixtures.js";

const runtimeContext: MasterPlanGraphContext = {
  userId: "athlete-342",
  generationId: "generation-342",
};

const snapshot = ContextSnapshotSchema.parse({
  schema_version: 1, user: { id: "athlete-342", profile: { display_name: null, dob: null, sex: null, height_cm: null, weight_kg: null, running_age_range: null } },
  injuries: [], personal_bests: [], running_calibration: null, race_history: [],
  macro_history: { start_date: "2024-08-10", end_date: "2026-08-10", months: [], peak_weekly_distance_km: null, longest_run_km: null, gap_periods: [], consistency_pct: null },
  recent_history: { start_date: "2026-04-20", end_date: "2026-08-10", weeks: [] },
  fitness_state: { as_of_date: "2026-08-10", ctl: null, atl: null, form: null },
  body_composition: { weight_kg: null, body_fat_pct: null, skeletal_muscle_kg: null },
  active_plan: null, current_phase: null, continuity: { active_plan_continuation: false, last_activity_date: null, days_since_last_run: null },
  coverage: [], source_manifest: [], as_of: "2026-08-10T00:00:00Z",
});

test("loads one immutable snapshot at the graph seam and passes it to the skeleton", async () => {
  const loads: unknown[] = [];
  const inputs: unknown[] = [];
  const graph = createMasterPlanGraph({
    contextProvider: { async loadSnapshot(userId, asOf) { loads.push([userId, asOf]); return snapshot; } },
    skeletonModel: { async invoke(input) { inputs.push(input); return createTestMasterPlan(); } },
  });

  const requestedAsOf = "2026-08-10T00:00:00Z";
  await graph.invoke({ request: { ...createTestRequest(), requested_as_of: requestedAsOf } }, { context: runtimeContext });

  assert.deepEqual(loads, [[runtimeContext.userId, requestedAsOf]]);
  assert.equal((inputs[0] as { snapshot: unknown }).snapshot, snapshot);
  assert.equal(Object.isFrozen(snapshot), true);
});

test("maps context-provider errors to typed infrastructure failure without fallback", async () => {
  let skeletonCalls = 0;
  const graph = createMasterPlanGraph({
    contextProvider: { async loadSnapshot() { throw new Error("mysql unavailable"); } },
    skeletonModel: { async invoke() { skeletonCalls += 1; return createTestMasterPlan(); } },
  });

  const { outcome } = await graph.invoke({ request: createTestRequest() }, { context: runtimeContext });

  assert.deepEqual(outcome, { decision: "infrastructure_failure", request_id: "request-342", generation_id: "generation-342", code: "context_snapshot_unavailable", retryable: true });
  assert.equal(skeletonCalls, 0);
});

test("compiled graph returns an inactive schema-valid new-season draft", async () => {
  const calls: unknown[] = [];
  const graph = createMasterPlanGraph({
    contextProvider: { async loadSnapshot() { return snapshot; } },
    skeletonModel: {
      async invoke(input) {
        calls.push(input);
        return createTestMasterPlan();
      },
    },
  });

  const { outcome } = await graph.invoke({ request: createTestRequest() }, { context: runtimeContext });

  assert.equal(MasterPlanGraphOutcome.safeParse(outcome).success, true);
  assert.equal(outcome.decision, "completed");
  if (outcome.decision !== "completed") assert.fail("expected completed outcome");
  assert.equal(outcome.artifact.activation_status, "inactive");
  assert.equal(outcome.artifact.plan.status, "draft");
  assert.equal(calls.length, 1);
});

test("unsupported modes terminate without invoking the skeleton dependency", async () => {
  let calls = 0;
  const graph = createMasterPlanGraph({
    contextProvider: { async loadSnapshot() { return snapshot; } },
    skeletonModel: {
      async invoke() {
        calls += 1;
        return createTestMasterPlan();
      },
    },
  });
  const request = { ...createTestRequest(), requested_mode: "strategy_preview" as const };

  const { outcome } = await graph.invoke({ request }, { context: runtimeContext });

  assert.deepEqual(outcome, {
    decision: "unsupported",
    request_id: "request-342",
    generation_id: "generation-342",
    artifact: {
      type: "capability_gap",
      requested_mode: "strategy_preview",
      supported_modes: ["new_season"],
    },
  });
  assert.equal(calls, 0);
});

test("compiled graph rejects malformed dependency output", async () => {
  const graph = createMasterPlanGraph({
    contextProvider: { async loadSnapshot() { return snapshot; } },
    skeletonModel: { async invoke() { return { status: "draft" }; } },
  });

  await assert.rejects(
    () => graph.invoke({ request: createTestRequest() }, { context: runtimeContext }),
    /Invalid input/,
  );
});

test("compiled graph rejects a candidate that changes the confirmed primary goal", async () => {
  const plan = createTestMasterPlan();
  plan.goal.race_date = "2026-11-01";
  const graph = createMasterPlanGraph({
    contextProvider: { async loadSnapshot() { return snapshot; } },
    skeletonModel: { async invoke() { return plan; } },
  });

  await assert.rejects(
    () => graph.invoke({ request: createTestRequest() }, { context: runtimeContext }),
    /candidate plan does not match confirmed primary goal/,
  );
});
