import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createWeeklyPlanGeneratorGraph,
	DataProviderWeeklyPlanContextProvider,
	loadConfig,
} from "coach_agent";
import { loadApiConfig } from "../config.js";
import { MySqlDataProvider } from "../data/mysqlDataProvider.js";

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
	const provider = MySqlDataProvider.create(loadApiConfig().strideDatabase);
	try {
		const contextProvider = new DataProviderWeeklyPlanContextProvider(provider);
		const graph = createWeeklyPlanGeneratorGraph(config, contextProvider);
		const generationId = `weekly-plan-${PROFILE}-${Date.now()}`;
		await graph.invoke(
			{
				request: {
					request_id: `weekly-plan-${Date.now()}`,
					requested_as_of: AS_OF,
				},
			},
			{ context: { userId: USER_ID, generationId } },
		);
	} finally {
		await provider.close();
	}
}

await main().catch((error) => {
	console.error(error);
	process.exit(1);
});
