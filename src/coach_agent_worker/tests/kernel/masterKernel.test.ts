import assert from "node:assert/strict";
import test from "node:test";
import { createMasterPlanGraph, FrozenMasterPlanContextProvider, MasterPlanGraphRequest } from "@stride/coach-agent";
import {
  createAssessmentSnapshot,
  createTestAthleteAssessment,
  createTestGoalAssessment,
  createTestJudgments,
  createTestMasterPlan,
  createTestRequest,
  createTestReviewReport,
  createTestStrategyCandidate,
} from "@stride/coach-agent/test-fixtures";
import { asPermanent } from "../../src/job/errors.js";
import { runMasterKernel, toMasterPlanGraphShim } from "../../src/kernel/masterKernel.js";

const runtime = { userId: "athlete-1", generationId: "plan-job-1" };
const request = MasterPlanGraphRequest.parse(createTestRequest());

interface GraphOverrides {
  snapshotThrows?: boolean;
  skeletonInvalid?: boolean;
}

function buildGraph(overrides: GraphOverrides = {}) {
  const snapshot = new FrozenMasterPlanContextProvider(createAssessmentSnapshot());
  return toMasterPlanGraphShim(
    createMasterPlanGraph({
      assessmentModel: {
        async invoke() {
          return createTestAthleteAssessment();
        },
      },
      goalAssessmentModel: {
        async invoke() {
          return createTestGoalAssessment();
        },
      },
      strategyModel: {
        async invoke({ archetype }: { archetype: string }) {
          return createTestStrategyCandidate(archetype as never);
        },
      },
      judgmentModel: {
        async invoke({ judge, candidate }: { judge: string; candidate: ReturnType<typeof createTestStrategyCandidate> }) {
          return createTestJudgments(candidate.candidate_id).find((item) => item.judge === (judge as never))!;
        },
      },
      reviewModel: {
        async invoke({ reviewerType }: { reviewerType: string }) {
          return createTestReviewReport(reviewerType as never);
        },
      },
      contextProvider: {
        async loadSnapshot() {
          if (overrides.snapshotThrows) throw new Error("mysql unavailable");
          return snapshot.loadSnapshot();
        },
      },
      skeletonModel: {
        async invoke() {
          if (overrides.skeletonInvalid) return { status: "draft" };
          return createTestMasterPlan();
        },
      },
    }),
  );
}

test("completed kernel run streams monotonic node progress and returns the plan", async () => {
  const graph = buildGraph();
  const hbCalls: Array<{ stage: string; pct: number }> = [];
  const { plan, revision } = await runMasterKernel(graph, request, runtime, async (stage, pct) => {
    hbCalls.push({ stage, pct });
  });

  assert.equal(plan.status, "draft");
  assert.ok(revision >= 1);
  assert.ok(hbCalls.length >= 5, `expected node progress, got ${hbCalls.length}`);
  assert.equal(hbCalls[0]?.stage, "reading_history");
  for (let i = 1; i < hbCalls.length; i++) {
    assert.ok(hbCalls[i]!.pct >= hbCalls[i - 1]!.pct, `progress regressed at ${i}: ${JSON.stringify(hbCalls)}`);
  }
  const last = hbCalls[hbCalls.length - 1]!;
  assert.ok(last.pct >= 88 && last.stage === "outputting");
});

test("context snapshot failure surfaces as a retryable infra error", async () => {
  const graph = buildGraph({ snapshotThrows: true });
  await assert.rejects(
    runMasterKernel(graph, request, runtime, async () => {}),
    (error: unknown) => {
      assert.equal(asPermanent(error), null);
      return true;
    },
  );
});

test("quality-gate failure maps to a permanent stable error code", async () => {
  const graph = buildGraph({ skeletonInvalid: true });
  await assert.rejects(
    runMasterKernel(graph, request, runtime, async () => {}),
    (error: unknown) => {
      const permanent = asPermanent(error);
      assert.ok(permanent, "expected a permanent error");
      assert.equal(permanent.code, "kernel_quality_gate_failed");
      return true;
    },
  );
});

test("kernel that ends without any outcome is a permanent error", async () => {
  const graph = {
    async stream() {
      return (async function* empty() {
        yield { some_unknown_node: { foo: 1 } };
      })();
    },
  };
  await assert.rejects(
    runMasterKernel(graph as never, request, runtime, async () => {}),
    (error: unknown) => {
      const permanent = asPermanent(error);
      assert.ok(permanent);
      assert.equal(permanent.code, "kernel_no_outcome");
      return true;
    },
  );
});
