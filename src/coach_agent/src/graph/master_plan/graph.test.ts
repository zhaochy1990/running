import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ContextSnapshotSchema,
  createMasterPlanGraph,
  MasterPlanGraphOutcome,
  type MasterPlanGraphContext,
} from "./index.js";
import { createAssessmentSnapshot, createTestAthleteAssessment, createTestGoalAssessment, createTestJudgments, createTestMasterPlan, createTestRequest, createTestStrategyCandidate } from "./testFixtures.js";

const runtimeContext: MasterPlanGraphContext = {
  userId: "athlete-342",
  generationId: "generation-342",
};

test("planning doctrine is packaged beside the compiled Kernel", async () => {
  await access(join(dirname(fileURLToPath(import.meta.url)), "doctrine", "planning.md"));
});

const snapshot = ContextSnapshotSchema.parse(createAssessmentSnapshot());
const strategies = ["conservative", "balanced", "aggressive_gated"] as const;
const assessmentDependencies = {
  assessmentModel: { async invoke() { return createTestAthleteAssessment(); } },
  goalAssessmentModel: { async invoke() { return createTestGoalAssessment(); } },
  strategyModel: { async invoke({ archetype }: { archetype: typeof strategies[number] }) { return createTestStrategyCandidate(archetype); } },
  judgmentModel: { async invoke({ judge, candidate }: { judge: "performance_path" | "safety_load" | "constraint_feasibility"; candidate: ReturnType<typeof createTestStrategyCandidate> }) { return createTestJudgments(candidate.candidate_id).find((item) => item.judge === judge)!; } },
};

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
  assert.deepEqual((inputs[0] as { snapshot: unknown }).snapshot, snapshot);
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
  if (outcome.decision !== "failed_quality_gate") assert.fail("expected quality failure");
  assert.equal(outcome.artifact.rule_report?.violations[0]?.rule_id, "schema_validity");
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

test("fans out independent strategies and judges, then passes only selected strategy to skeleton", async () => {
  const strategyInputs: unknown[] = [];
  const judgmentInputs: unknown[] = [];
  const skeletonInputs: unknown[] = [];
  const graph = createMasterPlanGraph({
    ...assessmentDependencies,
    contextProvider: { async loadSnapshot() { return snapshot; } },
    strategyModel: { async invoke(input) { strategyInputs.push(input); await new Promise((resolve) => setTimeout(resolve, input.archetype === "conservative" ? 20 : 1)); return createTestStrategyCandidate(input.archetype); } },
    judgmentModel: { async invoke(input) { judgmentInputs.push(input); return createTestJudgments(input.candidate.candidate_id).find((item) => item.judge === input.judge)!; } },
    skeletonModel: { async invoke(input) { skeletonInputs.push(input); return createTestMasterPlan(); } },
  });
  const { outcome } = await graph.invoke({ request: createTestRequest() }, { context: runtimeContext });
  assert.equal(outcome.decision, "completed");
  if (outcome.decision !== "completed") assert.fail("expected completed");
  assert.deepEqual(outcome.artifact.strategy_candidates.map((candidate) => candidate.candidate_id), ["strategy-aggressive-gated-v1", "strategy-balanced-v1", "strategy-conservative-v1"]);
  assert.equal(strategyInputs.length, 3);
  assert.equal(strategyInputs.every((input) => !("strategy_candidates" in (input as object))), true);
  assert.equal(judgmentInputs.length, 9);
  const skeleton = skeletonInputs[0] as Record<string, unknown>;
  assert.deepEqual(skeleton.selectedStrategy, outcome.artifact.selected_strategy);
  assert.equal("strategyCandidates" in skeleton, false);
});

test("all-vetoed strategies return a typed quality failure", async () => {
  const graph = createMasterPlanGraph({
    ...assessmentDependencies,
    contextProvider: { async loadSnapshot() { return snapshot; } },
    skeletonModel: { async invoke() { return createTestMasterPlan(); } },
    judgmentModel: { async invoke({ judge, candidate }) { return { ...createTestJudgments(candidate.candidate_id).find((item) => item.judge === judge)!, veto: true }; } },
  });
  const { outcome } = await graph.invoke({ request: createTestRequest() }, { context: runtimeContext });
  assert.equal(outcome.decision, "failed_quality_gate");
});

test("deterministic rule errors block completion after simulation", async () => {
  const plan = createTestMasterPlan();
  plan.weeks[0]!.key_sessions[0]!.distance_km = 30;
  const graph = createMasterPlanGraph({ ...assessmentDependencies, contextProvider: { async loadSnapshot() { return snapshot; } }, skeletonModel: { async invoke() { return plan; } } });
  const { outcome } = await graph.invoke({ request: createTestRequest() }, { context: runtimeContext });
  assert.equal(outcome.decision, "failed_quality_gate");
  if (outcome.decision !== "failed_quality_gate") assert.fail("expected failure");
  assert.ok(outcome.artifact.unresolved_issues.includes("long_run_share"));
  assert.equal(typeof outcome.artifact.simulation_report, "object");
  assert.equal(typeof outcome.artifact.rule_report, "object");
});

test("rule warnings are retained on a completed outcome", async () => {
  const graph = createMasterPlanGraph({ ...assessmentDependencies, contextProvider: { async loadSnapshot() { return snapshot; } }, skeletonModel: { async invoke() { return createTestMasterPlan(); } } });
  const { outcome } = await graph.invoke({ request: createTestRequest() }, { context: runtimeContext });
  assert.equal(outcome.decision, "completed");
  if (outcome.decision !== "completed") assert.fail("expected completed");
  assert.equal(typeof outcome.artifact.simulation_report, "object");
  assert.equal(typeof outcome.artifact.rule_report, "object");
});
