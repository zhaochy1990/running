import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfig } from "../../config/config.js";
import { createMasterPlanLlmModels } from "./llm/models.js";
import { goalAssessmentPrompt, reviewPrompt, strategyPrompt } from "./llm/prompts.js";

const MODEL: ModelConfig = {
  name: "test-responses",
  model: "test-model",
  endpoint: "http://127.0.0.1:1/v1",
  api_kind: "responses",
  api_key_env: "COACH_AGENT_TEST_API_KEY",
  max_tokens: 1024,
  timeout_s: 1,
};

test("createMasterPlanLlmModels loads every graph model without invoking an LLM", async () => {
  const models = await createMasterPlanLlmModels({
    masterPlanModel: MODEL,
    reviewerModel: MODEL,
  });

  assert.deepEqual(Object.keys(models).sort(), ["goalAssessmentModel", "judgmentModel", "reviewModel", "skeletonModel", "strategyModel"]);
  for (const model of Object.values(models)) {
    assert.equal(typeof model.invoke, "function");
  }
});

test("prompt builders keep runtime data in user messages", () => {
  const input = {
    request: { id: "request" },
    facts: { id: "facts" },
    snapshot: { id: "snapshot" },
  };
  const goalMessages = goalAssessmentPrompt(input);

  assert.equal(goalMessages[0]?.[0], "system");
  assert.deepEqual(JSON.parse(goalMessages[1]?.[1] ?? ""), {
    task: "Assess the confirmed race goal against the athlete capability facts",
    request: input.request,
    assessment_facts: input.facts,
    snapshot: input.snapshot,
  });
});

test("prompt builders append doctrine and review rubrics to system messages", () => {
  const input = { id: "input" };
  const strategyMessages = strategyPrompt(input, "DOCTRINE");
  const reviewMessages = reviewPrompt(input, "RUBRIC");

  assert.match(strategyMessages[0]?.[1] ?? "", /\n\nDOCTRINE$/);
  assert.match(reviewMessages[0]?.[1] ?? "", /\n\nRUBRIC$/);
  assert.equal(strategyMessages[1]?.[1], JSON.stringify(input));
  assert.equal(reviewMessages[1]?.[1], JSON.stringify(input));
});
