import assert from "node:assert/strict";
import test from "node:test";
import { HumanMessage } from "@langchain/core/messages";
import { MasterPlanSchema } from "@stride/contract";
import { createTestMasterPlan } from "../../graph/master_plan/testFixtures.js";
import { createMasterPlanValidationMiddleware } from "./validationMiddleware.js";

function afterModelHook() {
  const afterModel = createMasterPlanValidationMiddleware().afterModel;
  assert.ok(afterModel && typeof afterModel !== "function");
  return afterModel.hook;
}

function invalidMasterPlan() {
  const invalid = MasterPlanSchema.parse(createTestMasterPlan());
  const firstWeek = invalid.weeks[0];
  assert.ok(firstWeek);
  const firstSession = firstWeek.key_sessions[0];
  assert.ok(firstSession);
  firstWeek.is_recovery_week = true;
  firstWeek.key_sessions.push({ ...firstSession });
  return invalid;
}

test("canonical master-plan middleware accepts fully refined responses", async () => {
  const result = await afterModelHook()(
    {
      messages: [],
      structuredResponse: {
        disposition: "return_direct",
        content: createTestMasterPlan(),
      },
      _masterPlanValidationRetries: 0,
    } as never,
    {} as never,
  );
  assert.equal(result, undefined);
});

test("canonical master-plan middleware retries Zod cross-field failures", async () => {
  const invalid = invalidMasterPlan();
  const result = await afterModelHook()(
    {
      messages: [],
      structuredResponse: {
        disposition: "return_direct",
        content: invalid,
      },
      _masterPlanValidationRetries: 0,
    } as never,
    {} as never,
  );
  assert.ok(result);
  assert.equal(result.jumpTo, "model");
  assert.equal(result._masterPlanValidationRetries, 1);
  assert.ok(HumanMessage.isInstance(result.messages?.[0]));
});

test("canonical master-plan middleware caps invalid retries", () => {
  const invalid = invalidMasterPlan();
  assert.throws(() =>
    afterModelHook()(
      {
        messages: [],
        structuredResponse: {
          disposition: "return_direct",
          content: invalid,
        },
        _masterPlanValidationRetries: 2,
      } as never,
      {} as never,
    ),
  );
});
