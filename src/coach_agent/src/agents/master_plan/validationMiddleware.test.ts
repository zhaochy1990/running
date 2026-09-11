import assert from "node:assert/strict";
import test from "node:test";
import { HumanMessage } from "@langchain/core/messages";
import { PlanProposalDirectResponseSchema, PlanProposalSchema } from "@stride/contract";
import { createTestRequest } from "../../graph/master_plan/testFixtures.js";
import { createMasterPlanValidationMiddleware } from "./validationMiddleware.js";

function afterModelHook() {
  const afterModel = createMasterPlanValidationMiddleware().afterModel;
  assert.ok(afterModel && typeof afterModel !== "function");
  return afterModel.hook;
}

function validProposal() {
  return PlanProposalDirectResponseSchema.parse({
    disposition: "return_direct",
    content: {
      kind: "generate_master_plan",
      summary: "生成一份全马训练计划",
      request: createTestRequest(),
    },
  });
}

/** A proposal whose kernel request violates a cross-field refinement (two A goals). */
function invalidProposal() {
  const proposal = validProposal();
  proposal.content.request.goals.push({
    race_name: "上海马拉松",
    distance: "FM",
    race_date: "2026-11-29",
    target_time: "3:00:00",
    finish_only: false,
    priority: "A",
  });
  return proposal;
}

test("canonical proposal middleware accepts fully refined responses", async () => {
  const result = await afterModelHook()(
    {
      messages: [],
      structuredResponse: validProposal(),
      _masterPlanProposalRetries: 0,
    } as never,
    {} as never,
  );
  assert.equal(result, undefined);
});

test("canonical proposal middleware retries Zod cross-field failures", async () => {
  const result = await afterModelHook()(
    {
      messages: [],
      structuredResponse: invalidProposal(),
      _masterPlanProposalRetries: 0,
    } as never,
    {} as never,
  );
  assert.ok(result);
  assert.equal(result.jumpTo, "model");
  assert.equal(result._masterPlanProposalRetries, 1);
  assert.ok(HumanMessage.isInstance(result.messages?.[0]));
});

test("canonical proposal middleware caps invalid retries", () => {
  assert.throws(() =>
    afterModelHook()(
      {
        messages: [],
        structuredResponse: invalidProposal(),
        _masterPlanProposalRetries: 2,
      } as never,
      {} as never,
    ),
  );
});

test("PlanProposalSchema rejects a non-proposal envelope", () => {
  assert.equal(PlanProposalSchema.safeParse({ foo: "bar" }).success, false);
});
