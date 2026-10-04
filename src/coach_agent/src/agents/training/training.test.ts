import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage } from "@langchain/core/messages";
import { adjudicateMasterPlanReviews, MasterPlanGraphOutcome, MasterPlanGraphRequest } from "@stride/contract";
import type { RaceTarget } from "../../data/dataProvider.js";
import { deriveAssessmentFacts } from "../../graph/master_plan/assessment.js";
import { runMasterPlanRuleFilter } from "../../graph/master_plan/rules.js";
import { simulateMasterPlanLoad } from "../../graph/master_plan/simulation.js";
import {
  createAssessmentSnapshot,
  createTestGoalAssessment,
  createTestJudgments,
  createTestMasterPlan,
  createTestRequest,
  createTestReviewReport,
  createTestStrategyCandidate,
} from "../../graph/master_plan/testFixtures.js";
import { makeTrainingNode, type TrainingKernel } from "./node.js";
import { renderMasterPlanMarkdown } from "./render.js";
import { buildMasterPlanRequest } from "./request.js";

// ---------------------------------------------------------------------------
// request builder
// ---------------------------------------------------------------------------

const BASE_TARGET: RaceTarget = {
  goal_id: "goal-1",
  user_id: "user-1",
  status: "active",
  race_date: "2027-03-21",
  race_distance: "FM",
  race_name: "无锡马拉松",
  target_finish_time: "3:30:00",
  weekly_training_days: 5,
};

test("buildMasterPlanRequest maps a complete FM goal to a parseable kernel request", () => {
  const now = new Date("2026-10-04T08:00:00.000Z");
  const built = buildMasterPlanRequest(BASE_TARGET, { requestId: "chat-abc", now });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const parsed = MasterPlanGraphRequest.safeParse(built.request);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.equal(built.request.goals[0]?.distance, "FM");
  assert.equal(built.request.goals[0]?.target_time, "3:30:00");
  assert.equal(built.request.goals[0]?.finish_only, false);
  assert.equal(built.request.availability.weekly_run_days_max, 5);
  assert.equal(built.request.requested_mode, "new_season");
});

test("buildMasterPlanRequest accepts H:MM and normalises to H:MM:SS", () => {
  const built = buildMasterPlanRequest({ ...BASE_TARGET, target_finish_time: "2:50" }, { requestId: "r", now: new Date() });
  assert.equal(built.ok && built.request.goals[0]?.target_time, "2:50:00");
});

test("buildMasterPlanRequest maps an empty finish time to finish_only", () => {
  const built = buildMasterPlanRequest({ ...BASE_TARGET, target_finish_time: "" }, { requestId: "r", now: new Date() });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.request.goals[0]?.target_time, null);
  assert.equal(built.request.goals[0]?.finish_only, true);
});

test("buildMasterPlanRequest reports goal gaps", () => {
  assert.deepEqual(buildMasterPlanRequest(null, { requestId: "r", now: new Date() }).ok ? null : "gap", "gap");
  const tenK = buildMasterPlanRequest({ ...BASE_TARGET, race_distance: "10K" }, { requestId: "r", now: new Date() });
  assert.ok(!tenK.ok && tenK.gap.kind === "unsupported_distance");
  const badDate = buildMasterPlanRequest({ ...BASE_TARGET, race_date: "21/03/2027" }, { requestId: "r", now: new Date() });
  assert.ok(!badDate.ok && badDate.gap.kind === "invalid_goal");
  const badTime = buildMasterPlanRequest({ ...BASE_TARGET, target_finish_time: "about 3h30" }, { requestId: "r", now: new Date() });
  assert.ok(!badTime.ok && badTime.gap.kind === "invalid_goal");
});

test("buildMasterPlanRequest clamps stale weekly_training_days into the kernel window", () => {
  const built = buildMasterPlanRequest({ ...BASE_TARGET, weekly_training_days: 99 }, { requestId: "r", now: new Date() });
  assert.equal(built.ok && built.request.availability.weekly_run_days_max, 7);
});

// ---------------------------------------------------------------------------
// node behavior (fake kernel / fake goal store)
// ---------------------------------------------------------------------------

function fakeKernel(chunks: Array<Record<string, unknown>>, options: { delayMs?: number } = {}): TrainingKernel & { calls: number } {
  let calls = 0;
  const kernel: TrainingKernel & { calls: number } = {
    get calls() {
      return calls;
    },
    async stream() {
      calls += 1;
      return (async function* () {
        for (const chunk of chunks) {
          if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
          yield chunk;
        }
      })();
    },
  };
  return kernel;
}

function goalStore(target: RaceTarget | null) {
  return { getRaceTarget: async () => target };
}

const RUNTIME = { context: { userId: "user-1" } };

async function replyOf(node: ReturnType<typeof makeTrainingNode>, intentLabel: string | null = "master_plan") {
  const intent = intentLabel === null ? null : { intent: intentLabel };
  const result = (await node({ intent, messages: [] } as never, RUNTIME as never)) as { messages: unknown[]; llmCalls?: number };
  const last = result.messages.at(-1);
  assert.ok(last instanceof AIMessage);
  return { text: String(last.content), llmCalls: result.llmCalls ?? 0 };
}

test("training node answers non-master_plan intents without touching the kernel", async () => {
  const kernel = fakeKernel([]);
  const node = makeTrainingNode({ kernel, dataProvider: goalStore(BASE_TARGET) });
  const { text } = await replyOf(node, "weekly_plan");
  assert.match(text, /学习中/);
  assert.equal(kernel.calls, 0);
});

test("training node explains missing goals instead of generating", async () => {
  const kernel = fakeKernel([]);
  const node = makeTrainingNode({ kernel, dataProvider: goalStore(null) });
  const { text } = await replyOf(node);
  assert.match(text, /赛季目标/);
  assert.equal(kernel.calls, 0);
});

test("training node renders a completed kernel plan as text", async () => {
  const kernel = fakeKernel([
    { initialize: {} },
    { strategy_worker: {} },
    { judge_worker: {} },
    { review_worker: {} },
    { finalize: { outcome: completedOutcome() } },
  ]);
  const node = makeTrainingNode({ kernel, dataProvider: goalStore(BASE_TARGET) });
  const { text, llmCalls } = await replyOf(node);
  assert.match(text, /赛季训练计划初稿/);
  assert.ok(llmCalls >= 3, `expected llmCalls>=3, got ${llmCalls}`);
});

test("training node maps kernel decisions to athlete-facing text", async () => {
  const outcome = MasterPlanGraphOutcome.parse({
    decision: "needs_baseline",
    request_id: "r",
    generation_id: "g",
    artifact: { type: "baseline_requirements", missing: ["volume"], next_steps: ["Record two running weeks"] },
  });
  const node = makeTrainingNode({ kernel: fakeKernel([{ finalize: { outcome } }]), dataProvider: goalStore(BASE_TARGET) });
  const { text } = await replyOf(node);
  assert.match(text, /Record two running weeks/);
});

test("training node returns failure copy when the kernel throws", async () => {
  const kernel: TrainingKernel = {
    async stream() {
      throw new Error("model provider down");
    },
  };
  const node = makeTrainingNode({ kernel, dataProvider: goalStore(BASE_TARGET) });
  const { text } = await replyOf(node);
  assert.match(text, /没能完成/);
});

test("training node enforces the in-turn wall-clock budget", async () => {
  const kernel = fakeKernel([{ initialize: {} }, { strategy_worker: {} }, { finalize: { outcome: completedOutcome() } }], { delayMs: 30 });
  const node = makeTrainingNode({ kernel, dataProvider: goalStore(BASE_TARGET), timeoutMs: 10 });
  const { text } = await replyOf(node);
  assert.match(text, /超出.*限制/);
});

test("training node times out even when the kernel stream stalls silently", async () => {
  const kernel: TrainingKernel = {
    async stream() {
      return (async function* () {
        yield { initialize: {} };
        await new Promise(() => {}); // never resolves — silent stall
      })();
    },
  };
  const node = makeTrainingNode({ kernel, dataProvider: goalStore(BASE_TARGET), timeoutMs: 20 });
  const { text } = await replyOf(node);
  assert.match(text, /超出.*限制/);
});

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

test("renderMasterPlanMarkdown covers goal, phases and weeks", () => {
  const plan = createTestMasterPlan();
  const firstWeek = plan.weeks[0];
  assert.ok(firstWeek !== undefined);
  const text = renderMasterPlanMarkdown(plan);
  assert.match(text, new RegExp(plan.goal.race_name));
  assert.match(text, /阶段划分/);
  assert.match(text, /周骨架/);
  assert.match(text, new RegExp(`第 ${firstWeek.week_index} 周`));
});

// ---------------------------------------------------------------------------
// fixture: a schema-valid completed outcome (mirrors contracts.test.ts)
// ---------------------------------------------------------------------------

function completedOutcome(): MasterPlanGraphOutcome {
  const facts = deriveAssessmentFacts(createAssessmentSnapshot(), createTestRequest());
  const reviewReports = [createTestReviewReport("periodization"), createTestReviewReport("load_progression"), createTestReviewReport("constraint_grounding")];
  const conservative = createTestStrategyCandidate("conservative");
  const balanced = createTestStrategyCandidate("balanced");
  const outcome = {
    decision: "completed",
    request_id: "chat-test",
    generation_id: "gen-test",
    artifact: {
      type: "master_plan_draft",
      activation_status: "inactive",
      plan: createTestMasterPlan(),
      facts,
      goal_assessment: createTestGoalAssessment(),
      strategy_candidates: [conservative, balanced],
      judgments: [...createTestJudgments(conservative.candidate_id), ...createTestJudgments(balanced.candidate_id)],
      selected_strategy: {
        candidate: balanced,
        scores: { performance_path: 4, safety_load: 4, constraint_feasibility: 4, weighted_total: 4 },
        weights: { performance_path: 0.45, safety_load: 0.35, constraint_feasibility: 0.2 },
        rationale: "balanced wins",
        tradeoffs: ["moderate risk"],
      },
      simulation_report: simulateMasterPlanLoad(createTestMasterPlan(), createAssessmentSnapshot()),
      rule_report: runMasterPlanRuleFilter(createTestMasterPlan(), MasterPlanGraphRequest.parse(createTestRequest()), createAssessmentSnapshot()),
      artifact_revision: 1,
      review_reports: reviewReports,
      adjudication: adjudicateMasterPlanReviews(1, reviewReports, facts),
      warnings: [],
    },
  } as unknown;
  return MasterPlanGraphOutcome.parse(outcome);
}
