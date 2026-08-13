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
	try {
		const checkpointer = new MySqlSaver(pool);
		const store = new MySqlStore(pool);
		await checkpointer.setup();
		await store.setup();
		return { checkpointer, store, pool, close: () => pool.end() };
	} catch (error) {
		await pool.end();
		throw error;
	}
}

export { MySqlSaver } from "./checkpointer.js";
export { MySqlStore } from "./store.js";
