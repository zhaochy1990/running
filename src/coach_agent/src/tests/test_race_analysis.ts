import { loadConfig, readStrideMySqlConfig } from "../config/config.js";
import { StrideDataStore } from "../persistence/index.js";

const config = loadConfig();
const store = StrideDataStore.create(readStrideMySqlConfig(config));


async function main() {

}


try {
    await main();
} catch (err) {
    console.error("Error in test_race_analysis.ts:", err);
} finally {
    await store.close();
}
