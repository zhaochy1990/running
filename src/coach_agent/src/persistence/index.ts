/**
 * Coach-agent persistence — MySQL-backed checkpointer + store.
 *
 * `createPersistence()` ensures the database exists, creates the pool + tables,
 * and returns the LangGraph `checkpointer` and `store` to hand to
 * `createDeepAgent`, plus a `close()` to release the pool.
 */

import type { Pool } from "mysql2/promise";
import { MySqlSaver } from "./checkpointer.js";
import { createPool, ensureDatabase, readMySqlConfig } from "./mysql.js";
import { MySqlStore } from "./store.js";

export interface Persistence {
  checkpointer: MySqlSaver;
  store: MySqlStore;
  pool: Pool;
  close(): Promise<void>;
}

export async function createPersistence(): Promise<Persistence> {
  const config = readMySqlConfig();
  await ensureDatabase(config);
  const pool = createPool(config);

  const checkpointer = new MySqlSaver(pool);
  const store = new MySqlStore(pool);
  await checkpointer.setup();
  await store.setup();

  return {
    checkpointer,
    store,
    pool,
    close: () => pool.end(),
  };
}

export { MySqlSaver } from "./checkpointer.js";
export type {
  ActiveMasterPlanMetadata,
  Activity,
  DailyRecovery,
  DailyTrainingLoad,
  HeartRateZone,
  MasterPlanDocument,
  PaceZone,
  PersonalBest,
  RaceEffort,
  RunningCalibration,
  UserInjury,
  UserProfile,
  WeeklyFeedback,
  WeeklyPlanDocument,
} from "./dataStore.js";
export { StrideDataStore } from "./dataStore.js";
export { MySqlMasterPlanContextProvider } from "./masterPlanContextProvider.js";
export { createStridePool } from "./mysql.js";
export { MySqlStore } from "./store.js";
export type {
  WeeklyPlanContext,
  WeeklyPlanContextProvider,
} from "./weeklyPlanContextProvider.js";
export { MySqlWeeklyPlanContextProvider } from "./weeklyPlanContextProvider.js";
