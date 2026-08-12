import {
	getAgentConfig,
	loadConfig,
	readStrideMySqlConfig,
} from "../config/config.js";
import {
	createMasterPlanGraph,
	MasterPlanGraphRequest,
} from "../graph/master_plan/index.js";
import { createMasterPlanLlmModels } from "../graph/master_plan/llm/index.js";
import {
	MySqlMasterPlanContextProvider,
	StrideDataStore,
} from "../persistence/index.js";

type Profile = "local" | "prod";
const PROFILE = "local" as Profile;
const USER_ID = "11c2e582-5a85-4633-81d2-df7e37ad7b48";
const AS_OF = new Date("2026-08-07").toISOString();

export const config = loadConfig();
const modelConfig = getAgentConfig(config, "master_plan");
const reviewerConfig = getAgentConfig(config, "reviewer");
const store = StrideDataStore.create(readStrideMySqlConfig(config));

const provider = new MySqlMasterPlanContextProvider(store);

const request = MasterPlanGraphRequest.parse({
	request_id: `snapshot-${Date.now()}`,
	requested_mode: "new_season",
	requested_modifiers: [],
	goals: [
		{
			race_name: "西安马拉松",
			location: "西安",
			distance: "FM",
			race_date: "2026-10-18",
			target_time: "2:50:00",
			finish_only: false,
			priority: "A",
		},
	],
	availability: {
		weekly_run_days_max: 6,
		available_training_windows: [],
		unavailable_days: [],
		max_session_duration_min: 180,
		allows_double_sessions: true,
		preferred_long_run_day: "saturday",
		strength_sessions_per_week: 2,
		strength_available_days: ["monday", "thursday"],
	},
	injury_declarations: [],
	environment_constraints: [],
	travel_constraints: [],
	preferences: [],
	prohibited_arrangements: [],
	active_plan_action: "none",
	user_confirmations: {
		intake_complete: true,
		goals_confirmed: true,
		availability_confirmed: true,
		injury_history_confirmed: true,
		constraints_confirmed: true,
	},
	requested_as_of: AS_OF,
});

async function main() {
	try {
		const llmModels = await createMasterPlanLlmModels({
			masterPlanModel: modelConfig,
			reviewerModel: reviewerConfig,
		});
		const graph = createMasterPlanGraph({
			contextProvider: provider,
			...llmModels,
		});
		const generationId = `master-plan-${PROFILE}-${Date.now()}`;
		const result = await graph.invoke(
			{ request },
			{ context: { userId: USER_ID, generationId } },
		);
		console.log(result.outcome.decision);
	} finally {
		await store.close();
	}
}

await main().catch((error) => {
	console.error(error);
	process.exit(1);
});
