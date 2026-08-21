import assert from "node:assert/strict";
import test from "node:test";
import { adjudicateMasterPlanReviews, MasterPlanGraphOutcome, MasterPlanGraphRequest } from "@stride/contract";
import { deriveAssessmentFacts } from "./assessment.js";
import { runMasterPlanRuleFilter } from "./rules.js";
import { simulateMasterPlanLoad } from "./simulation.js";
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

test("outcome rejects decision and artifact mismatches", () => {
  const completed = completedOutcome();
  assert.equal(MasterPlanGraphOutcome.safeParse(completed).success, true);
  assert.equal(MasterPlanGraphOutcome.safeParse({ ...completed, artifact: undefined }).success, false);

  const safetyWithDraft = {
    ...completed,
    decision: "blocked_for_safety",
    reasons: ["acute pain"],
    prerequisites: ["medical clearance"],
  };
  assert.equal(MasterPlanGraphOutcome.safeParse(safetyWithDraft).success, false);
});

function completedOutcome() {
  const facts = deriveAssessmentFacts(createAssessmentSnapshot(), createTestRequest());
  const reviewReports = [createTestReviewReport("periodization"), createTestReviewReport("load_progression"), createTestReviewReport("constraint_grounding")];
  return {
    decision: "completed",
    request_id: "request-342",
    generation_id: "generation-342",
    artifact: {
      type: "master_plan_draft",
      activation_status: "inactive",
      plan: createTestMasterPlan(),
      facts,
      athlete_assessment: createTestAthleteAssessment(),
      goal_assessment: createTestGoalAssessment(),
      strategy_candidates: [createTestStrategyCandidate("conservative"), createTestStrategyCandidate("balanced")],
      judgments: [...createTestJudgments("strategy-conservative-v1"), ...createTestJudgments("strategy-balanced-v1")],
      selected_strategy: {
        candidate: createTestStrategyCandidate("balanced"),
        scores: {
          performance_path: 4,
          safety_load: 4,
          constraint_feasibility: 4,
          weighted_total: 4,
        },
        weights: {
          performance_path: 0.45,
          safety_load: 0.35,
          constraint_feasibility: 0.2,
        },
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
  };
}

test("completed outcome requires a complete candidate-judgment relationship", () => {
  const outcome = completedOutcome();
  outcome.artifact.judgments = outcome.artifact.judgments.filter(
    (judgment) => !(judgment.candidate_id === outcome.artifact.strategy_candidates[0]!.candidate_id && judgment.judge === "safety_load"),
  );
  assert.equal(MasterPlanGraphOutcome.safeParse(outcome).success, false);
});
