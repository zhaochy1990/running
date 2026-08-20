/**
 * MySQL-backed LangGraph checkpointer.
 *
 * Ports the in-memory `MemorySaver` logic (get/list/put/putWrites/deleteThread)
 * to MySQL so conversation threads and HITL pauses survive process restarts.
 *
 * Each checkpoint is stored self-contained (the whole serialized checkpoint,
 * channel values included) rather than the Postgres saver's blob-dedup scheme —
 * simpler, and fine for coach-sized state. Serialization uses the base
 * `SerializerProtocol` (JSON), same bytes the MemorySaver produces.
 */

import { BaseCheckpointSaver, WRITES_IDX_MAP, copyCheckpoint, getCheckpointId } from "@langchain/langgraph-checkpoint";
import type { ChannelVersions, Checkpoint, CheckpointListOptions, CheckpointMetadata, CheckpointTuple, PendingWrite } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { Pool, RowDataPacket } from "mysql2/promise";

export class MySqlSaver extends BaseCheckpointSaver {
  constructor(private readonly pool: Pool) {
    super();
  }

  /** Idempotent schema creation. */
  async setup(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id VARCHAR(255) CHARACTER SET ascii NOT NULL,
        checkpoint_ns VARCHAR(255) CHARACTER SET ascii NOT NULL DEFAULT '',
        checkpoint_id VARCHAR(255) CHARACTER SET ascii NOT NULL,
        parent_checkpoint_id VARCHAR(255) CHARACTER SET ascii NULL,
        type VARCHAR(64) NULL,
        checkpoint LONGBLOB NOT NULL,
        metadata LONGBLOB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      ) ENGINE=InnoDB
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS checkpoint_writes (
        thread_id VARCHAR(255) CHARACTER SET ascii NOT NULL,
        checkpoint_ns VARCHAR(255) CHARACTER SET ascii NOT NULL DEFAULT '',
        checkpoint_id VARCHAR(255) CHARACTER SET ascii NOT NULL,
        task_id VARCHAR(255) CHARACTER SET ascii NOT NULL,
        idx INT NOT NULL,
        channel VARCHAR(255) CHARACTER SET ascii NOT NULL,
        type VARCHAR(64) NULL,
        blob_data LONGBLOB NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      ) ENGINE=InnoDB
    `);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (threadId === undefined) return undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const checkpointId = getCheckpointId(config);

    const [rows] = checkpointId
      ? await this.pool.query<RowDataPacket[]>(`SELECT * FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`, [
          threadId,
          ns,
          checkpointId,
        ])
      : await this.pool.query<RowDataPacket[]>(`SELECT * FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? ORDER BY checkpoint_id DESC LIMIT 1`, [
          threadId,
          ns,
        ]);
    const row = rows[0];
    if (row === undefined) return undefined;
    return this.rowToTuple(row);
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { before, limit, filter } = options ?? {};
    const threadId = config.configurable?.thread_id as string | undefined;
    const ns = config.configurable?.checkpoint_ns as string | undefined;

    let sql = `SELECT * FROM checkpoints WHERE 1=1`;
    const params: unknown[] = [];
    if (threadId !== undefined) {
      sql += ` AND thread_id=?`;
      params.push(threadId);
    }
    if (ns !== undefined) {
      sql += ` AND checkpoint_ns=?`;
      params.push(ns);
    }
    if (before?.configurable?.checkpoint_id) {
      sql += ` AND checkpoint_id < ?`;
      params.push(before.configurable.checkpoint_id);
    }
    sql += ` ORDER BY checkpoint_id DESC`;

    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
    let remaining = limit ?? Infinity;
    for (const row of rows) {
      if (remaining <= 0) break;
      const metadata = (await this.serde.loadsTyped("json", row.metadata)) as CheckpointMetadata;
      if (filter && !Object.entries(filter).every(([k, v]) => (metadata as Record<string, unknown>)[k] === v)) {
        continue;
      }
      remaining -= 1;
      yield await this.rowToTuple(row, metadata);
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, _newVersions: ChannelVersions): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (threadId === undefined) {
      throw new Error("MySqlSaver.put: missing thread_id in config.configurable");
    }
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const parentId = (config.configurable?.checkpoint_id as string | undefined) ?? null;

    const [cType, cBytes] = await this.serde.dumpsTyped(copyCheckpoint(checkpoint));
    const [, mBytes] = await this.serde.dumpsTyped(metadata);

    await this.pool.execute(
      `INSERT INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         parent_checkpoint_id=VALUES(parent_checkpoint_id),
         type=VALUES(type), checkpoint=VALUES(checkpoint), metadata=VALUES(metadata)`,
      [threadId, ns, checkpoint.id, parentId, cType, Buffer.from(cBytes), Buffer.from(mBytes)],
    );

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    if (threadId === undefined || checkpointId === undefined) {
      throw new Error("MySqlSaver.putWrites: missing thread_id or checkpoint_id");
    }

    for (let i = 0; i < writes.length; i += 1) {
      const [channel, value] = writes[i]!;
      const [wType, wBytes] = await this.serde.dumpsTyped(value);
      const idx = WRITES_IDX_MAP[channel] ?? i;
      // idx >= 0: keep the first write (INSERT IGNORE); idx < 0 (special channels): overwrite.
      const conflict =
        idx >= 0
          ? `ON DUPLICATE KEY UPDATE thread_id=thread_id`
          : `ON DUPLICATE KEY UPDATE channel=VALUES(channel), type=VALUES(type), blob_data=VALUES(blob_data)`;
      await this.pool.execute(
        `INSERT INTO checkpoint_writes
           (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, blob_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ${conflict}`,
        [threadId, ns, checkpointId, taskId, idx, channel, wType, Buffer.from(wBytes)],
      );
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.pool.execute(`DELETE FROM checkpoints WHERE thread_id=?`, [threadId]);
    await this.pool.execute(`DELETE FROM checkpoint_writes WHERE thread_id=?`, [threadId]);
  }

  private async pendingWrites(threadId: string, ns: string, checkpointId: string): Promise<[string, string, unknown][]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT task_id, channel, type, blob_data FROM checkpoint_writes
       WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? ORDER BY task_id, idx`,
      [threadId, ns, checkpointId],
    );
    return Promise.all(
      rows.map(
        async (w): Promise<[string, string, unknown]> => [
          w.task_id as string,
          w.channel as string,
          await this.serde.loadsTyped((w.type as string) ?? "json", w.blob_data),
        ],
      ),
    );
  }

  private async rowToTuple(row: RowDataPacket, metadata?: CheckpointMetadata): Promise<CheckpointTuple> {
    const threadId = row.thread_id as string;
    const ns = row.checkpoint_ns as string;
    const checkpointId = row.checkpoint_id as string;
    const checkpoint = (await this.serde.loadsTyped((row.type as string) ?? "json", row.checkpoint)) as Checkpoint;
    const meta = metadata ?? ((await this.serde.loadsTyped("json", row.metadata)) as CheckpointMetadata);
    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: checkpointId,
        },
      },
      checkpoint,
      metadata: meta,
      pendingWrites: await this.pendingWrites(threadId, ns, checkpointId),
    };
    if (row.parent_checkpoint_id) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: row.parent_checkpoint_id as string,
        },
      };
    }
    return tuple;
  }
}
