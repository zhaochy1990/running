import assert from "node:assert/strict";
import test from "node:test";
import { MasterPlanGraphOutcome, MasterPlanGraphRequest } from "./contracts.js";
import { createTestMasterPlan, createTestRequest } from "./testFixtures.js";

test("request accepts explicit empty constraints in a complete confirmed intake", () => {
  const request = createTestRequest();
  assert.deepEqual(MasterPlanGraphRequest.parse(request), request);
});

test("request rejects omitted intake fields and unconfirmed answers", () => {
  const { preferences: _, ...missingPreferences } = createTestRequest();
  assert.equal(MasterPlanGraphRequest.safeParse(missingPreferences).success, false);

  const unconfirmed = createTestRequest();
  const invalidConfirmation = {
    ...unconfirmed,
    user_confirmations: { ...unconfirmed.user_confirmations, constraints_confirmed: false },
  };
  assert.equal(MasterPlanGraphRequest.safeParse(invalidConfirmation).success, false);
});

test("request rejects ambiguous primary race priorities", () => {
  const request = createTestRequest();
  const ambiguous = {
    ...request,
    goals: [
      ...request.goals,
      { ...request.goals[0]!, race_name: "上海马拉松", location: "上海" },
    ],
  };

  assert.equal(MasterPlanGraphRequest.safeParse(ambiguous).success, false);
});

test("outcome rejects decision and artifact mismatches", () => {
  const completed = {
    decision: "completed",
    request_id: "request-342",
    generation_id: "generation-342",
    artifact: {
      type: "master_plan_draft",
      activation_status: "inactive",
      plan: createTestMasterPlan(),
    },
  };
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
