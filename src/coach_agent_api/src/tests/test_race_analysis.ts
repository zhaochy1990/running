import { loadApiConfig } from "../config.js";
import { MySqlDataProvider } from "../data/mysqlDataProvider.js";

const provider = MySqlDataProvider.create(loadApiConfig().strideDatabase);

async function main() {}

try {
  await main();
} catch (error) {
  console.error("Error in test_race_analysis.ts:", error);
} finally {
  await provider.close();
}
