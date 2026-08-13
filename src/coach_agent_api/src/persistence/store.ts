/**
 * MySQL-backed LangGraph Store for long-term (cross-session) memory.
 *
 * Implements `BaseStore.batch` over a single `store` table keyed by
 * (namespace, key). Supports the operations the coach uses — put / get / search
 * (namespace-prefix) / listNamespaces. No vector search or TTL (add later).
 */

import type {
	Item,
	Operation,
	OperationResults,
	SearchItem,
} from "@langchain/langgraph-checkpoint";
import { BaseStore } from "@langchain/langgraph-checkpoint";
import type { Pool, RowDataPacket } from "mysql2/promise";

// Low-collision separator to flatten a namespace path into one string.
const SEP = "\u001f";

export class MySqlStore extends BaseStore {
	constructor(private readonly pool: Pool) {
		super();
	}

	/** Idempotent schema creation. */
	async setup(): Promise<void> {
		await this.pool.query(`
      CREATE TABLE IF NOT EXISTS store (
        ns VARCHAR(255) CHARACTER SET utf8mb4 NOT NULL,
        key_name VARCHAR(255) CHARACTER SET ascii NOT NULL,
        val LONGTEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (ns, key_name)
      ) ENGINE=InnoDB
    `);
	}

	async batch<Op extends Operation[]>(
		operations: Op,
	): Promise<OperationResults<Op>> {
		const results: unknown[] = [];
		for (const op of operations) {
			if ("namespacePrefix" in op) {
				results.push(await this._search(op));
			} else if ("value" in op) {
				results.push(await this._put(op));
			} else if ("key" in op && "namespace" in op) {
				results.push(await this._get(op));
			} else {
				results.push(await this._listNamespaces());
			}
		}
		return results as OperationResults<Op>;
	}

	private async _put(op: {
		namespace: string[];
		key: string;
		value: Record<string, unknown> | null;
	}): Promise<void> {
		const ns = op.namespace.join(SEP);
		if (op.value === null) {
			await this.pool.execute(`DELETE FROM store WHERE ns=? AND key_name=?`, [
				ns,
				op.key,
			]);
			return;
		}
		await this.pool.execute(
			`INSERT INTO store (ns, key_name, val) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE val=VALUES(val), updated_at=CURRENT_TIMESTAMP`,
			[ns, op.key, JSON.stringify(op.value)],
		);
	}

	private async _get(op: {
		namespace: string[];
		key: string;
	}): Promise<Item | null> {
		const ns = op.namespace.join(SEP);
		const [rows] = await this.pool.query<RowDataPacket[]>(
			`SELECT * FROM store WHERE ns=? AND key_name=?`,
			[ns, op.key],
		);
		return rows[0] ? this.rowToItem(rows[0]) : null;
	}

	private async _search(op: {
		namespacePrefix: string[];
		filter?: Record<string, unknown>;
		limit?: number;
		offset?: number;
	}): Promise<SearchItem[]> {
		const prefix = op.namespacePrefix.join(SEP);
		let sql = `SELECT * FROM store`;
		const params: unknown[] = [];
		if (prefix !== "") {
			sql += ` WHERE (ns = ? OR ns LIKE ?)`;
			params.push(prefix, `${prefix}${SEP}%`);
		}
		sql += ` ORDER BY updated_at DESC`;
		sql += ` LIMIT ${Number(op.limit ?? 10)} OFFSET ${Number(op.offset ?? 0)}`;

		const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
		let items = rows.map((r) => this.rowToItem(r));
		if (op.filter) {
			const entries = Object.entries(op.filter);
			items = items.filter((it) =>
				entries.every(([k, v]) => it.value[k] === v),
			);
		}
		return items;
	}

	private async _listNamespaces(): Promise<string[][]> {
		const [rows] = await this.pool.query<RowDataPacket[]>(
			`SELECT DISTINCT ns FROM store`,
		);
		return rows.map((r) => (r.ns as string).split(SEP));
	}

	private rowToItem(row: RowDataPacket): Item {
		const raw = row.val as string;
		return {
			namespace: (row.ns as string).split(SEP),
			key: row.key_name as string,
			value: JSON.parse(raw) as Record<string, unknown>,
			createdAt: row.created_at as Date,
			updatedAt: row.updated_at as Date,
		};
	}
}
