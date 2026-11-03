/**
 * Lottery staff-whitelist persistence (#867 admin management; epic #862).
 *
 * `lottery_staff` rows gate the mini-program verification page (P3): an
 * openid present — globally (activity_id NULL) or for one activity — may
 * query and redeem winning codes. This store is the admin-side CRUD seam:
 * add/list/remove. The whitelist itself is existential (no role, no expiry),
 * so a plain idempotent-`setup()` table like the other lottery tables; no
 * unique constraint on (openid, activity_id) — a duplicate entry is harmless
 * for the P3 existence check and removal is by row id.
 */
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export interface LotteryStaffRow {
  id: number;
  openid: string;
  /** null = 全局白名单（所有活动可核销）；否则仅该活动。 */
  activityId: number | null;
  note: string | null;
  createdAt: Date;
}

export interface LotteryStaffInput {
  openid: string;
  activityId?: number;
  note?: string;
}

/** Narrow port the admin staff routes consume. */
export interface LotteryStaffStore {
  /** Idempotent schema creation (same DDL as MySqlLotteryStore.setup()). */
  setup(): Promise<void>;
  /** 全部白名单（activity_id 升序、openid 升序）；activityId 给定时只列该活动 + 全局行。 */
  listStaff(activityId?: number): Promise<LotteryStaffRow[]>;
  addStaff(input: LotteryStaffInput): Promise<LotteryStaffRow>;
  /** Returns false when the row does not exist. */
  removeStaff(id: number): Promise<boolean>;
}

export class MySqlLotteryStaffStore implements LotteryStaffStore {
  constructor(private readonly pool: Pool) {}

  async setup(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS lottery_staff (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        openid VARCHAR(128) NOT NULL,
        activity_id BIGINT UNSIGNED NULL,
        note VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_openid (openid)
      ) ENGINE=InnoDB
    `);
  }

  async listStaff(activityId?: number): Promise<LotteryStaffRow[]> {
    const [rows] =
      activityId === undefined
        ? await this.pool.query<RowDataPacket[]>(`SELECT * FROM lottery_staff ORDER BY activity_id IS NULL, activity_id, openid, id`)
        : await this.pool.query<RowDataPacket[]>(
            `SELECT * FROM lottery_staff WHERE activity_id IS NULL OR activity_id=? ORDER BY activity_id IS NULL, activity_id, openid, id`,
            [activityId],
          );
    return rows.map(staffRow);
  }

  async addStaff(input: LotteryStaffInput): Promise<LotteryStaffRow> {
    const [result] = await this.pool.execute<ResultSetHeader>(`INSERT INTO lottery_staff (openid, activity_id, note) VALUES (?, ?, ?)`, [
      input.openid,
      input.activityId ?? null,
      input.note ?? null,
    ]);
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT * FROM lottery_staff WHERE id=?`, [result.insertId]);
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`lottery_staff: row missing after insert (id=${result.insertId})`);
    }
    return staffRow(row);
  }

  async removeStaff(id: number): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(`DELETE FROM lottery_staff WHERE id=?`, [id]);
    return result.affectedRows > 0;
  }
}

function staffRow(row: RowDataPacket): LotteryStaffRow {
  return {
    id: Number(row.id),
    openid: row.openid as string,
    activityId: row.activity_id === null || row.activity_id === undefined ? null : Number(row.activity_id),
    note: (row.note as string | null) ?? null,
    createdAt: row.created_at as Date,
  };
}
