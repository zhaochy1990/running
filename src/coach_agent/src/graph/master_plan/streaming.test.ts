import assert from "node:assert/strict";
import test from "node:test";
import { ContextSnapshotSchema, createMasterPlanGraph, type MasterPlanGraphContext, MasterPlanGraphOutcome } from "./index.js";
import {
  createAssessmentSnapshot,
  createTestAthleteAssessment,
  createTestGoalAssessment,
  createTestJudgments,
  createTestMasterPlan,
  createTestRequest,
  createTestReviewReport,
  createTestStrategyCandidate,
} from "./testFixtures.js";

// The plan-job worker consumes the kernel via `streamMode: ["updates"]` and
// reports one monotonic stage/progress anchor per node. This test pins the
// stream contract the worker relies on: per-superstep node-keyed chunks and a
// terminal `outcome` captured from the updates (no checkpointer is installed,
// so `getState` is unavailable — the worker must read the outcome from the
// stream itself).
const runtimeContext: MasterPlanGraphContext = {
  userId: "athlete-342",
  generationId: "generation-342",
};

test("streamMode updates yields node-keyed chunks and a terminal outcome", async () => {
  const snapshot = ContextSnapshotSchema.parse(createAssessmentSnapshot());
  const graph = createMasterPlanGraph({
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
        const judgment = createTestJudgments(candidate.candidate_id).find((item) => item.judge === (judge as never));
        if (judgment === undefined) throw new Error(`no fixture judgment for ${judge}`);
        return judgment;
      },
    },
    reviewModel: {
      async invoke({ reviewerType }: { reviewerType: string }) {
        return createTestReviewReport(reviewerType as never);
      },
    },
    contextProvider: {
      async loadSnapshot() {
        return snapshot;
      },
    },
    skeletonModel: {
      async invoke() {
        return createTestMasterPlan();
      },
    },
  });

  const seenNodes: string[] = [];
  let outcomeRaw: unknown = null;
  const stream = await graph.stream({ request: createTestRequest() }, { context: runtimeContext, streamMode: ["updates"] });
  for await (const rawChunk of stream) {
    // Array streamMode yields ["updates", {node: update}] tuples.
    const chunk = (Array.isArray(rawChunk) ? rawChunk[rawChunk.length - 1] : rawChunk) as Record<string, unknown>;
    for (const [nodeKey, update] of Object.entries(chunk)) {
      seenNodes.push(nodeKey.split(":")[0] as string);
      if (typeof update === "object" && update !== null && "outcome" in update) {
        outcomeRaw = (update as { outcome: unknown }).outcome;
      }
    }
  }

  // The graph begins at initialize and streams through the pipeline.
  assert.ok(seenNodes.includes("initialize"));
  assert.ok(seenNodes.includes("assess_athlete"));
  assert.ok(seenNodes.length >= 2);

  // The final outcome is captured from the stream, schema-valid and completed.
  assert.ok(outcomeRaw !== null, "stream must end with a terminal outcome");
  const outcome = MasterPlanGraphOutcome.parse(outcomeRaw);
  assert.equal(outcome.decision, "completed");
  assert.equal(outcome.artifact.plan.status, "draft");
  assert.ok(outcome.artifact.artifact_revision >= 1);
});
