import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentConfig, loadConfig, readStrideMySqlConfig } from "../config/config.js";
import { createWeeklyPlanGeneratorGraph } from "../graph/weekly_plan/index.js";
import { createWeeklyPlanLlm } from "../graph/weekly_plan/llm.js";
import {
	MySqlWeeklyPlanContextProvider,
	StrideDataStore,
} from "../persistence/index.js";

type Profile = "local" | "prod";
const PROFILE = "prod" as Profile;
const USER_ID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
const AS_OF = new Date("2026-08-16").toISOString();

const repoRoot = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
);

async function main() {
	const config = loadConfig({
		cwd: repoRoot,
		configFile: join(repoRoot, "config", `coach.${PROFILE}.yaml`),
	});
	const store = StrideDataStore.create(readStrideMySqlConfig(config));
	try {
		const provider = new MySqlWeeklyPlanContextProvider(store);
		const planLlm = await createWeeklyPlanLlm({
			weeklyPlanModel: getAgentConfig(config, "generate_weekly_plan"),
		});
		const graph = createWeeklyPlanGeneratorGraph(config, provider, planLlm);
		const generationId = `weekly-plan-${PROFILE}-${Date.now()}`;
		const result = await graph.invoke(
			{
				request: {
					request_id: `weekly-plan-${Date.now()}`,
					requested_as_of: AS_OF,
				},
			},
			{ context: { userId: USER_ID, generationId } },
		);
		console.log("--------------------");
		console.log(
			JSON.stringify(result.weekly_context?.training_position, null, 2),
		);
		console.log(JSON.stringify(result.weekly_context?.fitness_state, null, 2));
		console.log(JSON.stringify(result.weekly_context?.absorbed_load, null, 2));
		console.log(
			JSON.stringify(result.weekly_context?.recent_training_weeks, null, 2),
		);
		console.log(JSON.stringify(result.outcome, null, 2));
	} finally {
		await store.close();
	}
}

await main().catch((error) => {
	console.error(error);
	process.exit(1);
});
