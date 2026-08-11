import assert from "node:assert/strict";
import test from "node:test";
import {
  ContextSnapshotSchema,
  createMasterPlanGraph,
  MasterPlanGraphOutcome,
  type MasterPlanGraphContext,
} from "./index.js";
import { createAssessmentSnapshot, createTestAthleteAssessment, createTestGoalAssessment, createTestMasterPlan, createTestRequest } from "./testFixtures.js";

const runtimeContext: MasterPlanGraphContext = {
  userId: "athlete-342",
  generationId: "generation-342",
};

const snapshot = ContextSnapshotSchema.parse(createAssessmentSnapshot());
const assessmentDependencies = { assessmentModel: { async invoke() { return createTestAthleteAssessment(); } }, goalAssessmentModel: { async invoke() { return createTestGoalAssessment(); } } };

test("loads one immutable snapshot at the graph seam and passes it to the skeleton", async () => {
  const loads: unknown[] = [];
  const inputs: unknown[] = [];
  const graph = createMasterPlanGraph({
    ...assessmentDependencies,
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
    ...assessmentDependencies,
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
    ...assessmentDependencies,
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
    ...assessmentDependencies,
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

test("compiled graph reports malformed dependency output as a quality failure", async () => {
  const graph = createMasterPlanGraph({
    ...assessmentDependencies,
    contextProvider: { async loadSnapshot() { return snapshot; } },
    skeletonModel: { async invoke() { return { status: "draft" }; } },
  });

  const { outcome } = await graph.invoke({ request: createTestRequest() }, { context: runtimeContext });
  assert.equal(outcome.decision, "failed_quality_gate");
});

test("compiled graph reports a candidate that changes the confirmed primary goal", async () => {
  const plan = createTestMasterPlan();
  plan.goal.race_date = "2026-11-01";
  const graph = createMasterPlanGraph({
    ...assessmentDependencies,
    contextProvider: { async loadSnapshot() { return snapshot; } },
    skeletonModel: { async invoke() { return plan; } },
  });

  const { outcome } = await graph.invoke({ request: createTestRequest() }, { context: runtimeContext });
  assert.equal(outcome.decision, "failed_quality_gate");
});
