import {
  createMasterPlanGraph,
  createMasterPlanLlmModels,
  DataProviderMasterPlanContextProvider,
  getAgentConfig,
  loadConfig,
  MasterPlanGraphRequest,
} from "@stride/coach-agent";
import { loadApiConfig } from "../src/config.js";
import { coachAgentConfigFiles, coachApiConfigFiles } from "../src/configPaths.js";
import { MySqlDataProvider } from "@stride/coach-agent-worker";

type Profile = "local" | "prod";
const PROFILE = "prod" as Profile;
// configPaths resolves the overlay from STRIDE_COACH_ENV, so wire PROFILE into it
// before any config is loaded below.
process.env.STRIDE_COACH_ENV = PROFILE;
const USER_ID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
const AS_OF = new Date("2026-09-27").toISOString();

export const config = loadConfig({ configFiles: coachAgentConfigFiles(import.meta.url) });
const modelConfig = getAgentConfig(config, "master_plan");
const reviewerConfig = getAgentConfig(config, "reviewer");

const configFiles = coachApiConfigFiles(import.meta.url);
const store = MySqlDataProvider.create(loadApiConfig({ configFiles }).strideDatabase);

const provider = new DataProviderMasterPlanContextProvider(store);

const request = MasterPlanGraphRequest.parse({
  request_id: `snapshot-${Date.now()}`,
  requested_mode: "new_season",
  requested_modifiers: [],
  goals: [
    {
      race_name: "上海马拉松",
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
    preferred_long_run_day: "sunday",
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
    const result = await graph.invoke({ request }, { context: { userId: USER_ID, generationId } });
    console.log(result.outcome.decision);
  } finally {
    await store.close();
  }
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
