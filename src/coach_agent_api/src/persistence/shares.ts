/**
 * Coach chat share persistence (#715).
 *
 * The `coach_shares` table stores immutable share snapshots: the server
 * extracts the selected messages from the thread's checkpoint (clients cannot
 * forge coach content), and a public read route serves the snapshot without
 * touching the checkpoint afterwards.
 *
 * `sid` doubles as the share token: path segment, wxacode `scene` and
 * attribution in one — a 22-char base62 random string (unguessable, fits the
 * 32-visible-char scene limit, see #625). Re-sharing the exact same selection
 * upserts on `uk_selection` and returns the existing sid (idempotent reuse).
 *
 * `status` has no writer in v1 ('active' only); it is reserved for a future
 * revoke flow — the read route already distinguishes it from expiry.
 */
import { getLogger } from "@stride/common";
import type { Pool, RowDataPacket } from "mysql2/promise";

const logger = getLogger("coachShares");

export interface CoachShareRow {
  sid: string;
  userId: string;
  sessionId: string;
  selectionHash: string;
  messageCount: number;
  payload: Record<string, unknown>;
  totalBytes: number;
  wxacodeUrl: string | null;
  status: string;
  createdAt: Date;
}

export interface CoachShareInsert {
  sid: string;
  userId: string;
  sessionId: string;
  selectionHash: string;
  messageCount: number;
  payload: Record<string, unknown>;
  totalBytes: number;
}

/** Narrow persistence surface the share routes need. */
export interface CoachShareStore {
  /** Creates the share row, or returns the existing row for the same selection. */
  createOrGet(share: CoachShareInsert): Promise<{ sid: string; reused: boolean; wxacodeUrl: string | null }>;
  getBySid(sid: string): Promise<CoachShareRow | null>;
  setWxacodeUrl(sid: string, url: string): Promise<void>;
  /** Idempotent schema creation. */
  setup(): Promise<void>;
}

export class MySqlCoachShareStore implements CoachShareStore {
  constructor(private readonly pool: Pool) {}

  async setup(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS coach_shares (
        sid VARCHAR(22) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        session_id VARCHAR(64) NOT NULL,
        selection_hash CHAR(64) NOT NULL,
        message_count INT NOT NULL,
        payload JSON NOT NULL,
        total_bytes INT NOT NULL,
        wxacode_url VARCHAR(512) NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (sid),
        UNIQUE KEY uk_selection (user_id, session_id, selection_hash),
        KEY idx_user (user_id)
      ) ENGINE=InnoDB
    `);
  }

  async createOrGet(share: CoachShareInsert): Promise<{ sid: string; reused: boolean; wxacodeUrl: string | null }> {
    // ON DUPLICATE KEY UPDATE sid = sid is a no-op that lets the unique key
    // resolve concurrent races atomically. Its affectedRows cannot tell insert
    // from reuse: mysql2 enables CLIENT_FOUND_ROWS by default, so MySQL ≥8.4
    // reports affectedRows=1 for a duplicate no-change insert too (#722).
    await this.pool.execute(
      `INSERT INTO coach_shares
         (sid, user_id, session_id, selection_hash, message_count, payload, total_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE sid = sid`,
      [share.sid, share.userId, share.sessionId, share.selectionHash, share.messageCount, JSON.stringify(share.payload), share.totalBytes],
    );
    // Protocol-independent criterion: read the uk row back — it carries our
    // freshly generated sid iff the insert landed.
    const existing = await this.pool.query<RowDataPacket[]>(`SELECT sid, wxacode_url FROM coach_shares WHERE user_id=? AND session_id=? AND selection_hash=?`, [
      share.userId,
      share.sessionId,
      share.selectionHash,
    ]);
    const row = existing[0][0];
    if (row === undefined) {
      // The upsert did not error, so the row (ours or the racer's) must be
      // readable back; failing here is a read-your-write violation worth
      // failing loudly on.
      throw new Error(`coach_shares: selection row missing after upsert (sid=${share.sid})`);
    }
    if (row.sid === share.sid) {
      return { sid: share.sid, reused: false, wxacodeUrl: null };
    }
    return { sid: row.sid as string, reused: true, wxacodeUrl: (row.wxacode_url as string | null) ?? null };
  }

  async getBySid(sid: string): Promise<CoachShareRow | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT sid, user_id, session_id, selection_hash, message_count, payload, total_bytes, wxacode_url, status, created_at
         FROM coach_shares
        WHERE sid=?`,
      [sid],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      sid: row.sid as string,
      userId: row.user_id as string,
      sessionId: row.session_id as string,
      selectionHash: row.selection_hash as string,
      messageCount: row.message_count as number,
      payload: decodePayload(row.payload),
      totalBytes: row.total_bytes as number,
      wxacodeUrl: (row.wxacode_url as string | null) ?? null,
      status: row.status as string,
      createdAt: row.created_at as Date,
    };
  }

  async setWxacodeUrl(sid: string, url: string): Promise<void> {
    await this.pool.execute(`UPDATE coach_shares SET wxacode_url=? WHERE sid=?`, [url, sid]);
  }
}

/** mysql2 parses JSON columns; tolerate a driver returning the raw string. */
function decodePayload(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch (error) {
      logger.warn({ err: error }, "coach_shares payload is not valid JSON");
      return {};
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
