/**
 * Lottery configuration persistence (#863, epic #862 P1).
 *
 * Lays the full four-table foundation for the offline QR lottery domain —
 * this ticket owns activities + prize pools only; `lottery_participations`
 * (draw, P2) and `lottery_staff` (verification whitelist, P3) are created
 * here so their unique constraints ship with the schema from day one:
 *
 *   uk_user_activity  (user_id, activity_id)     — one draw per athlete
 *   uk_activity_provider (activity_id, provider_key) — one draw per provider account
 *     (provider_credentials has no such uniqueness — the lottery layer self-guards)
 *   uk_activity_code  (activity_id, code)        — 3-digit winning code uniqueness
 *
 * Style follows MySqlCoachShareStore: idempotent `setup()` DDL at startup, no
 * FK constraints (app-level integrity, consistent with the persistence seams).
 */
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export interface LotteryActivityRow {
  id: number;
  name: string;
  startAt: Date;
  endAt: Date;
  enabled: boolean;
  rulesText: string | null;
  heroImage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LotteryPrizeRow {
  id: number;
  activityId: number;
  name: string;
  imageUrl: string | null;
  /** Configured total stock. The fallback tier always carries 0 (never runs out). */
  stock: number;
  /** Drawable now; initialized to `stock`, decremented by the P2 draw under a row lock. */
  remaining: number;
  weight: number;
  isFallback: boolean;
}

export interface LotteryActivityInput {
  name: string;
  startAt: Date;
  endAt: Date;
  rulesText?: string;
  heroImage?: string;
}

export interface LotteryPrizeInput {
  name: string;
  imageUrl?: string;
  stock: number;
  weight: number;
  isFallback: boolean;
}

/** Narrow persistence surface the lottery routes need. */
export interface LotteryStore {
  /** Idempotent schema creation for all four lottery tables. */
  setup(): Promise<void>;
  createActivity(input: LotteryActivityInput): Promise<LotteryActivityRow>;
  updateActivity(id: number, input: LotteryActivityInput): Promise<LotteryActivityRow | null>;
  setActivityEnabled(id: number, enabled: boolean): Promise<LotteryActivityRow | null>;
  getActivity(id: number): Promise<LotteryActivityRow | null>;
  listActivities(): Promise<LotteryActivityRow[]>;
  /** Wholesale prize-pool replacement in one transaction; insertion order = display order. */
  replacePrizes(activityId: number, prizes: LotteryPrizeInput[]): Promise<LotteryPrizeRow[]>;
  listPrizes(activityId: number): Promise<LotteryPrizeRow[]>;
  /** True once any draw landed for the activity — guards pool replacement mid-flight. */
  hasParticipations(activityId: number): Promise<boolean>;
}

export class MySqlLotteryStore implements LotteryStore {
  constructor(private readonly pool: Pool) {}

  async setup(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS lottery_activities (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        name VARCHAR(128) NOT NULL,
        start_at TIMESTAMP NOT NULL,
        end_at TIMESTAMP NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        rules_text TEXT NULL,
        hero_image VARCHAR(512) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS lottery_prizes (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        activity_id BIGINT UNSIGNED NOT NULL,
        name VARCHAR(128) NOT NULL,
        image_url VARCHAR(512) NULL,
        stock INT NOT NULL DEFAULT 0,
        remaining INT NOT NULL DEFAULT 0,
        weight INT NOT NULL,
        is_fallback TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_activity (activity_id)
      ) ENGINE=InnoDB
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS lottery_participations (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        activity_id BIGINT UNSIGNED NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        openid VARCHAR(128) NULL,
        provider_key VARCHAR(255) NULL,
        prize_id BIGINT UNSIGNED NULL,
        code CHAR(3) NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'drawn',
        verified_by VARCHAR(128) NULL,
        verified_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_user_activity (user_id, activity_id),
        UNIQUE KEY uk_activity_provider (activity_id, provider_key),
        UNIQUE KEY uk_activity_code (activity_id, code)
      ) ENGINE=InnoDB
    `);
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

  async createActivity(input: LotteryActivityInput): Promise<LotteryActivityRow> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO lottery_activities (name, start_at, end_at, rules_text, hero_image) VALUES (?, ?, ?, ?, ?)`,
      [input.name, input.startAt, input.endAt, input.rulesText ?? null, input.heroImage ?? null],
    );
    const row = await this.getActivity(result.insertId);
    if (row === null) {
      throw new Error(`lottery_activities: row missing after insert (id=${result.insertId})`);
    }
    return row;
  }

  async updateActivity(id: number, input: LotteryActivityInput): Promise<LotteryActivityRow | null> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE lottery_activities SET name=?, start_at=?, end_at=?, rules_text=?, hero_image=? WHERE id=?`,
      [input.name, input.startAt, input.endAt, input.rulesText ?? null, input.heroImage ?? null, id],
    );
    if (result.affectedRows === 0) return null;
    return this.getActivity(id);
  }

  async setActivityEnabled(id: number, enabled: boolean): Promise<LotteryActivityRow | null> {
    const [result] = await this.pool.execute<ResultSetHeader>(`UPDATE lottery_activities SET enabled=? WHERE id=?`, [enabled ? 1 : 0, id]);
    if (result.affectedRows === 0) return null;
    return this.getActivity(id);
  }

  async getActivity(id: number): Promise<LotteryActivityRow | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT * FROM lottery_activities WHERE id=?`, [id]);
    const row = rows[0];
    return row === undefined ? null : activityRow(row);
  }

  async listActivities(): Promise<LotteryActivityRow[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT * FROM lottery_activities ORDER BY id DESC`);
    return rows.map(activityRow);
  }

  async replacePrizes(activityId: number, prizes: LotteryPrizeInput[]): Promise<LotteryPrizeRow[]> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(`DELETE FROM lottery_prizes WHERE activity_id=?`, [activityId]);
      if (prizes.length > 0) {
        const placeholders = prizes.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
        const values = prizes.flatMap((prize) => [
          activityId,
          prize.name,
          prize.imageUrl ?? null,
          prize.stock,
          prize.stock, // remaining starts at the configured stock
          prize.weight,
          prize.isFallback ? 1 : 0,
        ]);
        await connection.execute(
          `INSERT INTO lottery_prizes (activity_id, name, image_url, stock, remaining, weight, is_fallback) VALUES ${placeholders}`,
          values,
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.listPrizes(activityId);
  }

  async listPrizes(activityId: number): Promise<LotteryPrizeRow[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT * FROM lottery_prizes WHERE activity_id=? ORDER BY id`, [activityId]);
    return rows.map(prizeRow);
  }

  async hasParticipations(activityId: number): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT 1 FROM lottery_participations WHERE activity_id=? LIMIT 1`, [activityId]);
    return rows.length > 0;
  }
}

function activityRow(row: RowDataPacket): LotteryActivityRow {
  return {
    id: Number(row.id),
    name: row.name as string,
    startAt: row.start_at as Date,
    endAt: row.end_at as Date,
    enabled: Number(row.enabled) === 1,
    rulesText: (row.rules_text as string | null) ?? null,
    heroImage: (row.hero_image as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function prizeRow(row: RowDataPacket): LotteryPrizeRow {
  return {
    id: Number(row.id),
    activityId: Number(row.activity_id),
    name: row.name as string,
    imageUrl: (row.image_url as string | null) ?? null,
    stock: Number(row.stock),
    remaining: Number(row.remaining),
    weight: Number(row.weight),
    isFallback: Number(row.is_fallback) === 1,
  };
}
