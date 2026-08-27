import type { Pool } from "mysql2/promise";
import type { MySqlConfig } from "../dto/config.js";
import { CoordinatedTurnRunner } from "../turn/coordinator.js";
import { MySqlSaver } from "./checkpointer.js";
import { createPool, ensureDatabase } from "./mysql.js";
import { MySqlStore } from "./store.js";
import { MySqlThreadLock, MySqlTurnReceiptStore } from "./turns.js";

export interface Persistence {
  checkpointer: MySqlSaver;
  store: MySqlStore;
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
    const turnReceipts = new MySqlTurnReceiptStore(pool, checkpointer);
    await checkpointer.setup();
    await store.setup();
    await turnReceipts.setup();
    return {
      checkpointer,
      store,
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
export { MySqlStore } from "./store.js";
