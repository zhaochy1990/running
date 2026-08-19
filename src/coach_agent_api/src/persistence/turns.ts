import { createHash } from "node:crypto";
import type { Connection, Pool, RowDataPacket } from "mysql2/promise";
import mysql from "mysql2/promise";
import {
	ThreadBusyError,
	type ThreadLock,
	type TurnReceipt,
	type TurnReceiptStore,
} from "../turns.js";
import type { MySqlSaver } from "./checkpointer.js";
import type { MySqlConfig } from "./mysql.js";

export class MySqlTurnReceiptStore implements TurnReceiptStore {
	constructor(
		private readonly pool: Pool,
		private readonly checkpointer: MySqlSaver,
	) {}

	async setup(): Promise<void> {
		await this.pool.query(`
      CREATE TABLE IF NOT EXISTS coach_turn_receipts (
        thread_id VARCHAR(255) CHARACTER SET ascii NOT NULL,
        client_turn_id VARCHAR(128) CHARACTER SET ascii NOT NULL,
        fingerprint CHAR(64) CHARACTER SET ascii NOT NULL,
        response_json LONGTEXT NOT NULL,
        created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (thread_id, client_turn_id),
        INDEX idx_coach_turn_receipts_recent (thread_id, created_at)
      ) ENGINE=InnoDB
    `);
	}

	async get(
		threadId: string,
		clientTurnId: string,
	): Promise<TurnReceipt | undefined> {
		const [rows] = await this.pool.query<RowDataPacket[]>(
			`SELECT fingerprint, response_json FROM coach_turn_receipts
       WHERE thread_id=? AND client_turn_id=?`,
			[threadId, clientTurnId],
		);
		const row = rows[0];
		if (!row) return undefined;
		const response = JSON.parse(row.response_json as string) as unknown;
		if (
			typeof response !== "object" ||
			response === null ||
			Array.isArray(response)
		) {
			throw new Error("stored Coach turn response is invalid");
		}
		return {
			fingerprint: row.fingerprint as string,
			response: response as Record<string, unknown>,
		};
	}

	async recover(threadId: string, clientTurnId: string) {
		return this.checkpointer.recoverTurn(threadId, clientTurnId);
	}

	async put(
		threadId: string,
		clientTurnId: string,
		receipt: TurnReceipt,
	): Promise<void> {
		await this.pool.execute(
			`INSERT INTO coach_turn_receipts
       (thread_id, client_turn_id, fingerprint, response_json) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         response_json=IF(fingerprint=VALUES(fingerprint), VALUES(response_json), response_json)`,
			[
				threadId,
				clientTurnId,
				receipt.fingerprint,
				JSON.stringify(receipt.response),
			],
		);
	}

	async prune(threadId: string, keep: number): Promise<void> {
		const [rows] = await this.pool.query<RowDataPacket[]>(
			`SELECT client_turn_id FROM coach_turn_receipts
       WHERE thread_id=? ORDER BY created_at DESC, client_turn_id DESC`,
			[threadId],
		);
		for (const row of rows.slice(keep)) {
			await this.pool.execute(
				`DELETE FROM coach_turn_receipts WHERE thread_id=? AND client_turn_id=?`,
				[threadId, row.client_turn_id],
			);
		}
	}
}

export class MySqlThreadLock implements ThreadLock {
	constructor(private readonly config: MySqlConfig) {}

	async runExclusive<T>(
		threadId: string,
		operation: () => Promise<T>,
	): Promise<T> {
		const connection = await mysql.createConnection(this.config);
		const lockName = `coach:${createHash("sha256").update(threadId).digest("hex").slice(0, 58)}`;
		let acquired = false;
		try {
			await acquire(connection, lockName);
			acquired = true;
			return await operation();
		} finally {
			if (acquired) await release(connection, lockName);
			await connection.end();
		}
	}
}

async function acquire(
	connection: Connection,
	lockName: string,
): Promise<void> {
	const [rows] = await connection.query<RowDataPacket[]>(
		`SELECT GET_LOCK(?, 0) AS acquired`,
		[lockName],
	);
	if (Number(rows[0]?.acquired) !== 1) {
		throw new ThreadBusyError("timed out acquiring Coach thread lock");
	}
}

async function release(
	connection: Connection,
	lockName: string,
): Promise<void> {
	await connection.query(`SELECT RELEASE_LOCK(?)`, [lockName]);
}
