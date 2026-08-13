import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfig } from "../config/config.js";
import type { StrideDataStore } from "../persistence/index.js";
import { getMasterPlanGeneratorSubagent } from "./master_plan/agent.js";

test("master-plan generator exposes bounded context instead of raw history tools", () => {
	const config: ModelConfig = {
		name: "test",
		provider: "openai-compatible",
		model: "test-model",
		deployment: "test-model",
		endpoint: "http://127.0.0.1:1/v1",
		auth: "api-key",
		api_kind: "responses",
		max_tokens: 1000,
		timeout_s: 1,
	};
	const subagent = getMasterPlanGeneratorSubagent(
		{} as StrideDataStore,
		config,
	);
	const names = subagent.tools.map((tool) => tool.name);

	assert.ok(names.includes("get_master_plan_context"));
	assert.ok(names.includes("get_master_plan"));
	assert.ok(!names.includes("get_activities_by_date_range"));
	assert.ok(!names.includes("get_daily_training_load"));
	assert.ok(!names.includes("get_race_history"));
});
