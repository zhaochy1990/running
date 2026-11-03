/**
 * Lottery persistence (#863 activities + prize pools, #865 draw).
 *
 * Lays the full four-table foundation for the offline QR lottery domain:
 * `lottery_participations` (draw, #865) and `lottery_staff` (verification
 * whitelist, P3) were created with #863 so their unique constraints ship with
 * the schema from day one:
 *
 *   uk_user_activity  (user_id, activity_id)     — one draw per athlete
 *   uk_activity_provider (activity_id, provider_key) — one draw per provider account
 *     (provider_credentials has no such uniqueness — the lottery layer self-guards)
 *   uk_activity_code  (activity_id, code)        — 3-digit winning code uniqueness
 *
 * The #865 draw runs in ONE transaction with a fixed lock order
 * (participation row → prize rows → code rows → insert): concurrent draws of
 * the same activity serialize on the prize row locks, the stock decrement and
 * the participation insert commit or roll back together (no oversell), and the
 * unique constraints are the authoritative anti-replay backstop — a duplicate
 * key resolves to the existing result instead of an error.
 *
 * Style follows MySqlCoachShareStore: idempotent `setup()` DDL at startup, no
 * FK constraints (app-level integrity, consistent with the persistence seams).
 */
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

/** Code-collision retry bound inside one draw transaction (collisions are impossible under the prize locks; defensive). */
const DRAW_MAX_ATTEMPTS = 8;

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

export interface LotteryParticipationRow {
  id: number;
  activityId: number;
  userId: string;
  /** Mini-program openid; null at draw time (the coach JWT carries no openid), P3 verification fills its own provenance. */
  openid: string | null;
  /** `${provider}:${account}` anti-fraud key; always set by the #865 draw (watch binding is a hard gate). */
  providerKey: string | null;
  /** Winning tier id — the fallback tier for "谢谢参与" results. */
  prizeId: number | null;
  /** 3-digit zero-padded winning code (000-999); null for fallback results. */
  code: string | null;
  status: string;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
}

/** One allocation decision made inside the draw transaction (#865). */
export interface DrawAllocation {
  /** The tier the weighted roll landed on (a row of the locked prize read). */
  prize: LotteryPrizeRow;
  /** 3-digit code for physical wins; null for the fallback tier or when the code space is exhausted. */
  code: string | null;
}

export type DrawOutcome =
  | { outcome: "created"; participation: LotteryParticipationRow; prize: LotteryPrizeRow }
  /** The unique constraints answered for a concurrent/retried replay — return the existing result, not an error. */
  | { outcome: "duplicate"; participation: LotteryParticipationRow; prize: LotteryPrizeRow | null }
  /** The same watch account (provider_key) already drew this activity through another stride account. */
  | { outcome: "provider_conflict" };

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
  getPrize(id: number): Promise<LotteryPrizeRow | null>;
  /** True once any draw landed for the activity — guards pool replacement mid-flight. */
  hasParticipations(activityId: number): Promise<boolean>;
  getParticipation(activityId: number, userId: string): Promise<LotteryParticipationRow | null>;
  /**
   * The #865 draw: stock-aware allocation + 3-digit code assignment + stock
   * decrement in one transaction. `allocate` is pure domain logic injected by
   * the route layer (weighted pick + free-code pick); it receives the locked
   * prize rows and the currently occupied codes so every attempt re-reads the
   * latest in-transaction state.
   */
  drawParticipation(input: {
    activityId: number;
    userId: string;
    providerKey: string;
    allocate(prizes: LotteryPrizeRow[], occupiedCodes: ReadonlySet<string>): DrawAllocation;
  }): Promise<DrawOutcome>;
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

  async getPrize(id: number): Promise<LotteryPrizeRow | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT * FROM lottery_prizes WHERE id=?`, [id]);
    const row = rows[0];
    return row === undefined ? null : prizeRow(row);
  }

  async hasParticipations(activityId: number): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT 1 FROM lottery_participations WHERE activity_id=? LIMIT 1`, [activityId]);
    return rows.length > 0;
  }

  async getParticipation(activityId: number, userId: string): Promise<LotteryParticipationRow | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT * FROM lottery_participations WHERE activity_id=? AND user_id=?`, [activityId, userId]);
    const row = rows[0];
    return row === undefined ? null : participationRow(row);
  }

  /**
   * Transactional draw (#865). Lock order is fixed so concurrent draws of one
   * activity cannot deadlock: own participation row → all prize rows → all
   * occupied code rows, then insert. The insert runs BEFORE the stock decrement
   * so a failed attempt leaves no side effects inside the transaction; a
   * uk_activity_code race (theoretically impossible under the prize locks,
   * defensive anyway) just re-allocates. Everything commits or rolls back
   * together — a won tier and its deducted stock are atomic (no oversell).
   */
  async drawParticipation(input: {
    activityId: number;
    userId: string;
    providerKey: string;
    allocate(prizes: LotteryPrizeRow[], occupiedCodes: ReadonlySet<string>): DrawAllocation;
  }): Promise<DrawOutcome> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // 1. Replay check under a row lock: a concurrent same-user draw
      //    serializes here and resolves to the committed result.
      const [existing] = await connection.execute<RowDataPacket[]>(`SELECT * FROM lottery_participations WHERE activity_id=? AND user_id=? FOR UPDATE`, [
        input.activityId,
        input.userId,
      ]);
      if (existing[0] !== undefined) {
        await connection.commit();
        const participation = participationRow(existing[0]);
        return { outcome: "duplicate", participation, prize: await this.prizeOf(participation) };
      }

      // 2. Lock every prize row of the activity: stock reads are current and
      //    concurrent draws serialize on this lock for their whole transaction.
      const [prizePackets] = await connection.execute<RowDataPacket[]>(`SELECT * FROM lottery_prizes WHERE activity_id=? FOR UPDATE`, [input.activityId]);
      const prizes = prizePackets.map(prizeRow);

      // 3. Occupied codes as a locking read — sees codes committed by any draw
      //    that held the prize locks before us.
      const [codePackets] = await connection.execute<RowDataPacket[]>(
        `SELECT code FROM lottery_participations WHERE activity_id=? AND code IS NOT NULL FOR UPDATE`,
        [input.activityId],
      );
      const occupied = new Set<string>(codePackets.map((packet) => String(packet.code)));

      // 4. Allocate → insert → deduct, retrying only on a code-collision race.
      let insertedId: number | undefined;
      for (let attempt = 0; attempt < DRAW_MAX_ATTEMPTS && insertedId === undefined; attempt++) {
        const allocation = input.allocate(prizes, occupied);
        if (!allocation.prize.isFallback && allocation.code === null) {
          throw new Error(`lottery code space exhausted (activity ${input.activityId})`);
        }
        try {
          const [insert] = await connection.execute<ResultSetHeader>(
            `INSERT INTO lottery_participations (activity_id, user_id, provider_key, prize_id, code) VALUES (?, ?, ?, ?, ?)`,
            [input.activityId, input.userId, input.providerKey, allocation.prize.id, allocation.prize.isFallback ? null : allocation.code],
          );
          insertedId = insert.insertId;
        } catch (error) {
          if (uniqueKeyOf(error) === "uk_activity_code" && attempt < DRAW_MAX_ATTEMPTS - 1 && allocation.code !== null) {
            occupied.add(allocation.code); // lose the race for this code; pick a fresh one
            continue;
          }
          throw error;
        }
        // 5. Decrement AFTER a successful insert — same transaction as the
        //    winning draw (#865 防超发). The row lock guarantees remaining > 0;
        //    the guard is defensive against a broken prize row.
        if (!allocation.prize.isFallback) {
          const [decrement] = await connection.execute<ResultSetHeader>(`UPDATE lottery_prizes SET remaining = remaining - 1 WHERE id=? AND remaining > 0`, [
            allocation.prize.id,
          ]);
          if (decrement.affectedRows !== 1) {
            throw new Error(`prize ${allocation.prize.id} ran out of stock inside the draw transaction`);
          }
        }
      }
      if (insertedId === undefined) {
        throw new Error(`lottery code allocation exhausted retries (activity ${input.activityId})`);
      }
      await connection.commit();
      const participation = await this.getParticipation(input.activityId, input.userId);
      if (participation === null) {
        throw new Error(`lottery_participations: row missing after draw commit (id=${insertedId})`);
      }
      const prize = await this.prizeOf(participation);
      if (prize === null) {
        throw new Error(`lottery draw: prize ${participation.prizeId} missing after commit`);
      }
      return { outcome: "created", participation, prize };
    } catch (error) {
      await connection.rollback();
      // The unique constraints are the authoritative anti-fraud backstop:
      // classify the losing race instead of surfacing an error.
      const key = uniqueKeyOf(error);
      if (key === "uk_user_activity") {
        const participation = await this.getParticipation(input.activityId, input.userId);
        if (participation !== null) {
          return { outcome: "duplicate", participation, prize: await this.prizeOf(participation) };
        }
      }
      if (key === "uk_activity_provider") {
        return { outcome: "provider_conflict" };
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  private async prizeOf(participation: LotteryParticipationRow): Promise<LotteryPrizeRow | null> {
    return participation.prizeId === null ? null : this.getPrize(participation.prizeId);
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

function participationRow(row: RowDataPacket): LotteryParticipationRow {
  return {
    id: Number(row.id),
    activityId: Number(row.activity_id),
    userId: row.user_id as string,
    openid: (row.openid as string | null) ?? null,
    providerKey: (row.provider_key as string | null) ?? null,
    prizeId: row.prize_id === null || row.prize_id === undefined ? null : Number(row.prize_id),
    code: (row.code as string | null) ?? null,
    status: row.status as string,
    verifiedBy: (row.verified_by as string | null) ?? null,
    verifiedAt: (row.verified_at as Date | null) ?? null,
    createdAt: row.created_at as Date,
  };
}

/**
 * Which lottery unique constraint a MySQL duplicate-key error hit, if any.
 * mysql2 reports the constraint name inside the message ("... for key
 * 'lottery_participations.uk_user_activity'"); the three names are distinctive
 * enough to match on directly.
 */
function uniqueKeyOf(error: unknown): "uk_user_activity" | "uk_activity_provider" | "uk_activity_code" | undefined {
  const message = error instanceof Error ? `${error.message} ${(error as { sqlMessage?: string }).sqlMessage ?? ""}` : String(error);
  for (const key of ["uk_user_activity", "uk_activity_provider", "uk_activity_code"] as const) {
    if (message.includes(key)) return key;
  }
  return undefined;
}
