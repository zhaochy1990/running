import assert from "node:assert/strict";
import test from "node:test";
import { createMasterPlanGraph, FrozenMasterPlanContextProvider, MasterPlanGraphRequest } from "@stride/coach-agent";
import {
  createAssessmentSnapshot,
  createTestGoalAssessment,
  createTestJudgments,
  createTestMasterPlan,
  createTestRequest,
  createTestReviewReport,
  createTestStrategyCandidate,
} from "@stride/coach-agent/test-fixtures";
import { asPermanent, ERROR_CODES } from "../../src/job/errors.js";
import { createMasterPlanJobHandler, type MasterPlanHandlerDeps } from "../../src/kernel/master/handler.js";
import { toMasterPlanGraphShim } from "../../src/kernel/master/kernel.js";
import { FakePlanJobStore } from "../job/fakes.js";

const GOAL_ID = "11111111-2222-3333-4444-555555555555";

function buildGraph() {
  const snapshot = new FrozenMasterPlanContextProvider(createAssessmentSnapshot());
  return toMasterPlanGraphShim(
    createMasterPlanGraph({
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
          return snapshot.loadSnapshot();
        },
      },
      skeletonModel: {
        async invoke() {
          return createTestMasterPlan();
        },
      },
    }),
  );
}

function deps(overrides: Partial<MasterPlanHandlerDeps> = {}): MasterPlanHandlerDeps {
  return {
    graph: buildGraph(),
    resolveGoalId: async () => GOAL_ID,
    ...overrides,
  };
}

test("completed master run reports the full v2 content in result_json (#585, no draft insert)", async () => {
  const handler = createMasterPlanJobHandler(deps());
  const job = FakePlanJobStore.fixture({ inputJson: JSON.stringify(MasterPlanGraphRequest.parse(createTestRequest())) });
  const result = await handler(job, async () => {});

  const parsed = JSON.parse(result.result) as { content: Record<string, unknown>; revision: number; generated_by: string };
  assert.equal(parsed.revision, 1);
  assert.equal(parsed.generated_by, "plan-job");

  const content = parsed.content as {
    goal: { goal_id: string };
    phases: Array<{ id: string; milestone_ids: string[] }>;
    milestones: Array<{ id: string; phase_id: string; type: string; target: string }>;
    weeks: Array<{ phase_id: string; week_index: number }>;
    start_date: string;
    total_weeks: number;
  };
  assert.equal(content.goal.goal_id, GOAL_ID);
  assert.ok(content.phases[0]?.id);
  assert.ok(Array.isArray(content.phases[0]?.milestone_ids));
  assert.ok(Array.isArray(content.milestones));
  assert.ok(content.weeks[0]?.phase_id);
  assert.ok(content.start_date.length > 0 && content.total_weeks >= 1);
});

test("invalid enqueued request is a terminal contract violation", async () => {
  const handler = createMasterPlanJobHandler(deps());
  const job = FakePlanJobStore.fixture({ inputJson: JSON.stringify({ request_id: "broken" }) });
  await assert.rejects(
    handler(job, async () => {}),
    (error: unknown) => {
      const permanent = asPermanent(error);
      assert.ok(permanent);
      assert.equal(permanent.code, ERROR_CODES.CONTRACT_VIOLATION);
      return true;
    },
  );
});

test("missing active race goal fails terminally", async () => {
  const handler = createMasterPlanJobHandler(deps({ resolveGoalId: async () => null }));
  const job = FakePlanJobStore.fixture({ inputJson: JSON.stringify(MasterPlanGraphRequest.parse(createTestRequest())) });
  await assert.rejects(
    handler(job, async () => {}),
    (error: unknown) => {
      const permanent = asPermanent(error);
      assert.ok(permanent);
      assert.equal(permanent.code, ERROR_CODES.NO_ACTIVE_RACE_GOAL);
      return true;
    },
  );
});
