import assert from "node:assert/strict";
import test from "node:test";
import type { CoachAgentConfig } from "../../config/config.js";
import type {
	WeeklyPlanContext,
	WeeklyPlanContextProvider,
} from "../../persistence/weeklyPlanContextProvider.js";
import { createWeeklyPlanGeneratorGraph } from "./index.js";

const config: CoachAgentConfig = {
	models: [],
	agents: [],
	observability: {
		langsmith_enabled: false,
		langsmith_project: "",
		langsmith_endpoint: "",
		langsmith_api_key_env: "",
	},
};

const context: WeeklyPlanContextProvider = {
	async loadSnapshot(_userId, asOf) {
		return {
			as_of: asOf,
			plan_start: "2026-08-17",
			week_name: "2026-08-17_08-23",
			lookback: { start_date: "2026-07-18", end_date: "2026-08-14", days: 28 },
			user_profile: {
				age: 47,
				weight_kg: 68,
				threshold_pace_s_per_km: 250,
				threshold_speed_mps: 4,
				lactate_threshold_hr: 170,
				rhr_baseline: 50,
				heart_rate_zones: [],
				pace_zones: [],
			},
			training_position: { phase: null, stage: null },
			recent_activities: [],
			recent_training_weeks: [],
			absorbed_load: {
				complete_weeks_considered: [],
				distance_anchor_km: null,
				latest_complete_week: null,
			},
			recent_feedback: [],
			fitness_state: {},
			injury: [],
			recovery: {
				latest: null,
				seven_day_average: { rhr: null, hrv: null },
				history: [],
				provenance: { source: "raw_health_measurements" },
			},
		} as WeeklyPlanContext;
	},
};

const runtimeContext = { userId: "athlete-342", generationId: "generation-1" };

test("weekly plan generator greets the default world without shouting", async () => {
	const graph = createWeeklyPlanGeneratorGraph(config, context);
	const { outcome } = await graph.invoke(
		{ request: { request_id: "request-1" } },
		{ context: runtimeContext },
	);

	assert.deepEqual(outcome, {
		decision: "completed",
		request_id: "request-1",
		generation_id: "generation-1",
		greeting: "Hello, world!",
		shouted: false,
	});
});

test("weekly plan generator shouts a custom name", async () => {
	const graph = createWeeklyPlanGeneratorGraph(config, context);
	const { outcome } = await graph.invoke(
		{ request: { request_id: "request-2", name: "athlete" } },
		{ context: runtimeContext },
	);

	assert.deepEqual(outcome, {
		decision: "completed",
		request_id: "request-2",
		generation_id: "generation-1",
		greeting: "HELLO, ATHLETE!",
		shouted: true,
	});
});

test("weekly plan generator loads the context snapshot first", async () => {
	const loads: Array<[string, string]> = [];
	const graph = createWeeklyPlanGeneratorGraph(config, {
		async loadSnapshot(userId, asOf) {
			loads.push([userId, asOf]);
			return context.loadSnapshot(userId, asOf);
		},
	});

	await graph.invoke(
		{
			request: {
				request_id: "request-3",
				requested_as_of: "2026-08-16T00:00:00Z",
			},
		},
		{ context: runtimeContext },
	);

	assert.deepEqual(loads, [["athlete-342", "2026-08-16T00:00:00Z"]]);
});

test("weekly plan generator maps context-provider errors to a typed failure", async () => {
	const graph = createWeeklyPlanGeneratorGraph(config, {
		async loadSnapshot() {
			throw new Error("mysql unavailable");
		},
	});

	const { outcome } = await graph.invoke(
		{ request: { request_id: "request-4" } },
		{ context: runtimeContext },
	);

	assert.deepEqual(outcome, {
		decision: "infrastructure_failure",
		request_id: "request-4",
		generation_id: "generation-1",
		reason: "context_snapshot_unavailable",
	});
});

test("weekly plan generator rejects unknown request fields", async () => {
	const graph = createWeeklyPlanGeneratorGraph(config, context);
	await assert.rejects(
		() =>
			graph.invoke(
				{ request: { request_id: "request-5", extra: 1 } } as never,
				{ context: runtimeContext },
			),
		/Unrecognized key/,
	);
});
