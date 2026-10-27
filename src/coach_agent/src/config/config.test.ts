import assert from "node:assert/strict";
import { test } from "node:test";
import { getAgentConfig } from "./config.js";
import type { CoachAgentConfig } from "./types.js";

/** role 覆盖通道：per-agent 覆盖盖掉共享模型基值，未覆盖字段取基值。 */
const config: CoachAgentConfig = {
  models: [
    {
      name: "flash",
      model: "deepseek-flash",
      endpoint: "https://api.deepseek.com",
      api_key_env: "DEEPSEEK_API_KEY",
      api_kind: "responses",
      temperature: 0.4,
      max_tokens: 4096,
      timeout_s: 120,
    },
  ],
  agents: [
    { name: "phasing", model: "flash", temperature: 0.15, max_tokens: 65536 },
    { name: "master_plan", model: "flash" },
  ],
  observability: {
    langsmith_enabled: false,
    langsmith_project: "test",
    langsmith_endpoint: "https://api.smith.langchain.com",
    langsmith_api_key_env: "LANGSMITH_API_KEY",
  },
};

test("getAgentConfig role 覆盖：temperature 覆盖生效（#810）、既有通道不回归、未覆盖取基值", () => {
  const phasing = getAgentConfig(config, "phasing");
  assert.equal(phasing.temperature, 0.15);
  assert.equal(phasing.max_tokens, 65536);
  assert.equal(phasing.timeout_s, 120);

  const master = getAgentConfig(config, "master_plan");
  assert.equal(master.temperature, 0.4);
  assert.equal(master.max_tokens, 4096);
});
