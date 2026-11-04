import type { CoachRaceTargetRef, RaceTargetBindingGateway, RaceTargetCandidate } from "@stride/coach-agent";
import type { Pool, RowDataPacket } from "mysql2/promise";

/**
 * Per-thread race target binding（devops#891 聊天内绑赛）：一行一个会话线程，
 * 绑定值与候选集同表。绑定由 bind_race_target（仅候选集内 ID）写入，API 层在
 * 续轮读出后自动注入 turn scope——聊天入口没有 UI 每轮带 target，持久层就是
 * 为此存在。候选集是 bind 的防注入闸门：模型只能绑服务端检索给过的组合。
 */
export class MySqlThreadRaceTargetStore implements RaceTargetBindingGateway {
  constructor(private readonly pool: Pool) {}

  async setup(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS coach_thread_race_targets (
        thread_id VARCHAR(255) CHARACTER SET ascii NOT NULL,
        race_event_id BIGINT UNSIGNED NULL,
        item_type VARCHAR(32) NULL,
        candidates_json JSON NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (thread_id)
      ) ENGINE=InnoDB
    `);
  }

  async get(threadId: string): Promise<CoachRaceTargetRef | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT race_event_id, item_type FROM coach_thread_race_targets
       WHERE thread_id=? AND race_event_id IS NOT NULL AND item_type IS NOT NULL`,
      [threadId],
    );
    const row = rows[0];
    if (!row) return null;
    const raceEventId = row.race_event_id;
    const itemType = row.item_type;
    if (typeof raceEventId !== "number" || typeof itemType !== "string" || itemType.length === 0) return null;
    return { kind: "race", race_event_id: raceEventId, item_type: itemType };
  }

  async bind(threadId: string, ref: CoachRaceTargetRef): Promise<void> {
    await this.pool.execute(
      `INSERT INTO coach_thread_race_targets (thread_id, race_event_id, item_type)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE race_event_id=VALUES(race_event_id), item_type=VALUES(item_type)`,
      [threadId, ref.race_event_id, ref.item_type],
    );
  }

  async rememberCandidates(threadId: string, candidates: RaceTargetCandidate[]): Promise<void> {
    // 只覆盖候选集，不动已存在的绑定列（新行插入时绑定列为 NULL）。
    await this.pool.execute(
      `INSERT INTO coach_thread_race_targets (thread_id, candidates_json)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE candidates_json=VALUES(candidates_json)`,
      [threadId, JSON.stringify(candidates)],
    );
  }

  async candidates(threadId: string): Promise<RaceTargetCandidate[] | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT candidates_json FROM coach_thread_race_targets WHERE thread_id=?`, [threadId]);
    // mysql2 parses JSON columns; tolerate a driver returning the raw string（同 shares.ts decodePayload）。
    const raw = rows[0]?.candidates_json;
    let parsed: unknown;
    if (typeof raw === "string") {
      if (raw.length === 0) return null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
    } else {
      parsed = raw;
    }
    if (!Array.isArray(parsed)) return null;
    const candidates: RaceTargetCandidate[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const raceEventId = record.race_event_id;
      const itemType = record.item_type;
      const name = record.name;
      const raceDate = record.race_date;
      const city = record.city;
      if (typeof raceEventId !== "number" || !Number.isInteger(raceEventId) || raceEventId <= 0) continue;
      if (typeof itemType !== "string" || itemType.length === 0) continue;
      if (typeof name !== "string" || typeof raceDate !== "string") continue;
      candidates.push({
        race_event_id: raceEventId,
        item_type: itemType,
        name,
        race_date: raceDate,
        city: typeof city === "string" ? city : null,
      });
    }
    return candidates.length > 0 ? candidates : null;
  }
}
