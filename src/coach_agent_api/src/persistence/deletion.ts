/**
 * Account-erasure support for the coach persistence database.
 *
 * Deletes the four coach-owned shapes for one user: conversation checkpoints,
 * pending checkpoint writes, turn receipts, and long-term memory (the `store`
 * table). Thread-scoped rows are keyed by the canonical
 * `{userId}:coach:{sessionId}` thread id, so they are removed by prefix; the
 * user id is LIKE-escaped so a crafted id cannot widen the match.
 *
 * Plan-job state is NOT here: ADR 0033 moved it onto the Go `jobs` table, which
 * stride-api's DeleteUserData already removes.
 *
 * This lives in the persistence layer because it writes SQL directly (AGENTS.md
 * SQL ownership). The admin route only drives it.
 */
import type { Pool, ResultSetHeader } from "mysql2/promise";

/** Long-term memory namespace prefix used by the coach (see agents/memory.ts). */
export const ATHLETE_MEMORY_NAMESPACE = "athlete_memory";

/** Namespace path separator; must match store.ts. */
const SEP = "\u001f";

export interface CoachDataDeleter {
  /** Deletes every coach row for userId and returns per-table affected counts. */
  deleteForUser(userId: string): Promise<Record<string, number>>;
}

export class MySqlCoachDataDeleter implements CoachDataDeleter {
  constructor(private readonly pool: Pool) {}

  async deleteForUser(userId: string): Promise<Record<string, number>> {
    const threadPrefix = escapeLike(`${userId}:coach:`);
    const memoryExact = `${ATHLETE_MEMORY_NAMESPACE}${SEP}${userId}`;
    const memoryPrefix = escapeLike(memoryExact);

    return {
      checkpoints: await this.delete("DELETE FROM checkpoints WHERE thread_id LIKE ?", [`${threadPrefix}%`]),
      checkpoint_writes: await this.delete("DELETE FROM checkpoint_writes WHERE thread_id LIKE ?", [`${threadPrefix}%`]),
      coach_turn_receipts: await this.delete("DELETE FROM coach_turn_receipts WHERE thread_id LIKE ?", [`${threadPrefix}%`]),
      // Long-term memory: the exact namespace plus any nested suffix namespaces.
      store: await this.delete("DELETE FROM store WHERE ns = ? OR ns LIKE ?", [memoryExact, `${memoryPrefix}${SEP}%`]),
    };
  }

  private async delete(sql: string, params: string[]): Promise<number> {
    const [result] = await this.pool.execute(sql, params);
    return (result as ResultSetHeader).affectedRows ?? 0;
  }
}

/** Escape LIKE wildcards so a user id cannot match unintended rows. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
