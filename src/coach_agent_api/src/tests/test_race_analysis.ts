import { loadConfig } from "coach_agent";
import { loadStrideDataConfig } from "../config.js";
import { MySqlDataProvider } from "../data/mysqlDataProvider.js";

loadConfig();
const provider = MySqlDataProvider.create(loadStrideDataConfig());

async function main() {}

try {
	await main();
} catch (error) {
	console.error("Error in test_race_analysis.ts:", error);
} finally {
	await provider.close();
}
