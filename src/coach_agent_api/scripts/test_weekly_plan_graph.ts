import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWeeklyPlanGeneratorGraph, DataProviderWeeklyPlanContextProvider, loadConfig } from "coach_agent";
import { loadApiConfig } from "../src/config.js";
import { MySqlDataProvider } from "../src/data/mysqlDataProvider.js";

type Profile = "local" | "prod";
const PROFILE = "prod" as Profile;
const AS_OF = new Date("2026-08-16").toISOString();

const usernameMap: Record<string, string> = {
  // pan: "5ee229a6-cdc1-4260-84d3-71ec622126c2",
  dingchentao: "7bd56762-3b04-42a6-9d8b-98f595628430",
  lvge: "0a74ac88-629e-4b8e-97c8-d49ccf5a986b",
  dehua: "bef8d1fe-c617-4cc4-9e6f-bf6a8ce79ba9",
  renzhen: "bffa65bc-4501-41e7-a68c-96da76d5b7bc",
  zhaochaoyi: "f10bc353-01ab-4db1-af9f-d9305ea9a532",
};

function requireUserId(): { userId: string; username: string } {
  const username = process.argv[2];
  if (!username) {
    console.error("Missing username. Usage: npm run test:weekly-plan-graph -- <user>");
    process.exit(1);
  }
  const userId = usernameMap[username];
  if (!userId) {
    console.error(`Unknown username: ${username}. Valid usernames: ${Object.keys(usernameMap).join(", ")}`);
    process.exit(1);
  }
  return { userId, username };
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const outputDir = join(repoRoot, "src", "coach_agent", "test-output", "weekly-plan-graph");

function savePlan(plan: unknown, username: string): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace("T", "_").replace("Z", "");
  const outputPath = join(outputDir, `${timestamp}_${username}.json`);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(plan, null, 2));
  return outputPath;
}

async function main() {
  const { userId, username } = requireUserId();
  const config = loadConfig({
    cwd: repoRoot,
    configFile: join(repoRoot, "config", `coach.${PROFILE}.yaml`),
  });
  const provider = MySqlDataProvider.create(loadApiConfig().strideDatabase);
  try {
    const contextProvider = new DataProviderWeeklyPlanContextProvider(provider);
    const graph = createWeeklyPlanGeneratorGraph(config, contextProvider);
    const generationId = `weekly-plan-${PROFILE}-${Date.now()}`;
    const result = await graph.invoke(
      {
        request: {
          request_id: `weekly-plan-${Date.now()}`,
          requested_as_of: AS_OF,
        },
      },
      { context: { userId, generationId } },
    );
    if (result.outcome.decision !== "completed" || !result.outcome.weekly_plan) {
      throw new Error(`Weekly plan generation failed: ${JSON.stringify(result.outcome)}`);
    }
    const outputPath = savePlan(result.outcome.weekly_plan, username);
    console.log(`Generated weekly plan written to ${outputPath}`);
  } finally {
    await provider.close();
  }
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
