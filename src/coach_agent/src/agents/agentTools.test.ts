import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ModelConfig } from "../config/config.js";
import { StrideDataStore } from "../persistence/index.js";
import { getMasterPlanSubagent } from "./master_plan/agent.js";
import { getQaSubagent } from "./qa/agent.js";
import { getCoachSubagent } from "./weekly_plan/agent.js";
import { MASTER_PLAN_PROMPT } from "./prompts.js";

const modelConfig: ModelConfig = {
  name: "test",
  provider: "openai-compatible",
  model: "test-model",
  deployment: "test",
  endpoint: "http://127.0.0.1:1",
  auth: "api-key",
  api_kind: "responses",
  max_tokens: 100,
  timeout_s: 1,
};

test("master-plan skills are present in the compiled virtual filesystem root", async () => {
  const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
  await Promise.all([
    access(join(skillsDir, "analyze-race", "SKILL.md")),
    access(join(skillsDir, "generate-master-plan", "SKILL.md")),
  ]);
});

test("master-plan prompt gates athlete data behind a complete race goal", () => {
  assert.match(MASTER_PLAN_PROMPT, /先只调用 get_master_plan/);
  assert.match(MASTER_PLAN_PROMPT, /暂停并等待用户回答/);
});

test("master-plan prompt requires canonical MasterPlan JSON output", () => {
  assert.match(MASTER_PLAN_PROMPT, /MasterPlan JSON 输出契约/);
  assert.match(MASTER_PLAN_PROMPT, /只输出一个 JSON 对象/);
});

test("all athlete-facing subagents expose PB and running-calibration tools", () => {
  const store = new StrideDataStore({} as never);
  const subagents = [
    getQaSubagent(store, modelConfig),
    getCoachSubagent(store, modelConfig),
    getMasterPlanSubagent(store, modelConfig),
  ];

  for (const subagent of subagents) {
    const toolNames = subagent.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("get_personal_bests"), `${subagent.name} lacks PB tool`);
    assert.ok(toolNames.includes("get_running_calibration"), `${subagent.name} lacks calibration tool`);
  }
});
