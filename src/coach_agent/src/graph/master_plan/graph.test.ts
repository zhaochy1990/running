import assert from "node:assert/strict";
import test from "node:test";
import {
  createMasterPlanGraph,
  MasterPlanGraphOutcome,
  type MasterPlanGraphContext,
} from "./index.js";
import { createTestMasterPlan, createTestRequest } from "./testFixtures.js";

const runtimeContext: MasterPlanGraphContext = {
  userId: "athlete-342",
  generationId: "generation-342",
};

test("compiled graph returns an inactive schema-valid new-season draft", async () => {
  const calls: unknown[] = [];
  const graph = createMasterPlanGraph({
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
    skeletonModel: { async invoke() { return plan; } },
  });

  await assert.rejects(
    () => graph.invoke({ request: createTestRequest() }, { context: runtimeContext }),
    /candidate plan does not match confirmed primary goal/,
  );
});
