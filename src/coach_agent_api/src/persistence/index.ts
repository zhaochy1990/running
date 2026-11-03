import type { Pool } from "mysql2/promise";
import type { MySqlConfig } from "../dto/config.js";
import { CoordinatedTurnRunner } from "../turn/coordinator.js";
import { MySqlSaver } from "./checkpointer.js";
import { MySqlLotteryStore } from "./lottery.js";
import { createPool, ensureDatabase } from "./mysql.js";
import { MySqlCoachShareStore } from "./shares.js";
import { MySqlStore } from "./store.js";
import { MySqlThreadLock, MySqlTurnReceiptStore } from "./turns.js";

export interface Persistence {
  checkpointer: MySqlSaver;
  store: MySqlStore;
  /** Coach chat share snapshots (#715). */
  shares: MySqlCoachShareStore;
  /** Lottery activity configuration domain (#863). */
  lottery: MySqlLotteryStore;
  turnCoordinator: CoordinatedTurnRunner;
  pool: Pool;
  close(): Promise<void>;
}

export async function createPersistence(config: MySqlConfig): Promise<Persistence> {
  await ensureDatabase(config);
  const pool = createPool(config);
  try {
    const checkpointer = new MySqlSaver(pool);
    const store = new MySqlStore(pool);
    const shares = new MySqlCoachShareStore(pool);
    const lottery = new MySqlLotteryStore(pool);
    const turnReceipts = new MySqlTurnReceiptStore(pool, checkpointer);
    await checkpointer.setup();
    await store.setup();
    await shares.setup();
    await lottery.setup();
    await turnReceipts.setup();
    return {
      checkpointer,
      store,
      shares,
      lottery,
      turnCoordinator: new CoordinatedTurnRunner(turnReceipts, new MySqlThreadLock(config)),
      pool,
      close: () => pool.end(),
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export { MySqlSaver } from "./checkpointer.js";
export { MySqlLotteryStore } from "./lottery.js";
export { MySqlCoachShareStore } from "./shares.js";
export { MySqlStore } from "./store.js";
