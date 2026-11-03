/**
 * Lottery funnel persistence (#867 数据看板; epic #862).
 *
 * The admin dashboard's participation funnel has two halves:
 *
 *   - Pre-draw stages (进入 enter / 登录 login / 绑表 bind) have no
 *     transactional record, so the mini-program landing page pings a public
 *     `POST .../events` endpoint at each stage transition; rows are appended
 *     here (best-effort analytics, counted as 次数 — page views / pings).
 *   - Post-draw stages (抽奖 draw / 中奖 win / 核销 verified) are derived
 *     from `lottery_participations` — the authoritative transactional rows —
 *     so they are counted as 人数, never re-reported by the client.
 *
 * `funnelByScene` merges both halves grouped by 点位渠道号 (the scene `s`
 * parameter baked into each QR stand; NULL scene = direct links / no channel).
 */
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export const LOTTERY_EVENT_STAGES = ["enter", "login", "bind"] as const;
export type LotteryEventStage = (typeof LOTTERY_EVENT_STAGES)[number];

export interface LotteryEventInput {
  activityId: number;
  stage: LotteryEventStage;
  /** 点位渠道号；直链/未带为 null。 */
  scene: string | null;
  /** 已登录 ping 尽量带上（login/bind 阶段有）；enter 匿名。 */
  userId: string | null;
}

/** One scene row of the admin funnel: pre-draw 次数 + post-draw 人数. */
export interface LotteryFunnelSceneRow {
  scene: string | null;
  enter: number;
  login: number;
  bind: number;
  draw: number;
  win: number;
  verified: number;
}

/** Narrow port the dashboard routes consume. */
export interface LotteryFunnelStore {
  /** Idempotent schema creation for the append-only event log. */
  setup(): Promise<void>;
  recordEvent(input: LotteryEventInput): Promise<void>;
  /**
   * Funnel per scene, scenes sorted by first appearance in the stage order
   * (busiest first is not needed — the dashboard renders all rows); the NULL
   * scene (直链) sorts last.
   */
  funnelByScene(activityId: number): Promise<LotteryFunnelSceneRow[]>;
}

export class MySqlLotteryFunnelStore implements LotteryFunnelStore {
  constructor(private readonly pool: Pool) {}

  async setup(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS lottery_events (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        activity_id BIGINT UNSIGNED NOT NULL,
        scene VARCHAR(32) NULL,
        stage VARCHAR(16) NOT NULL,
        user_id VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_activity_stage (activity_id, stage)
      ) ENGINE=InnoDB
    `);
  }

  async recordEvent(input: LotteryEventInput): Promise<void> {
    await this.pool.execute<ResultSetHeader>(`INSERT INTO lottery_events (activity_id, scene, stage, user_id) VALUES (?, ?, ?, ?)`, [
      input.activityId,
      input.scene,
      input.stage,
      input.userId,
    ]);
  }

  async funnelByScene(activityId: number): Promise<LotteryFunnelSceneRow[]> {
    const [eventRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT scene, stage, COUNT(*) AS cnt FROM lottery_events
        WHERE activity_id=? AND stage IN ('enter','login','bind') GROUP BY scene, stage`,
      [activityId],
    );
    const [participationRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT scene,
              COUNT(*) AS draw_cnt,
              SUM(code IS NOT NULL) AS win_cnt,
              SUM(verified_at IS NOT NULL) AS verified_cnt
         FROM lottery_participations WHERE activity_id=? GROUP BY scene`,
      [activityId],
    );

    const byScene = new Map<string, LotteryFunnelSceneRow>();
    const rowOf = (scene: string | null): LotteryFunnelSceneRow => {
      const key = scene ?? "\u0000null";
      let row = byScene.get(key);
      if (row === undefined) {
        row = { scene, enter: 0, login: 0, bind: 0, draw: 0, win: 0, verified: 0 };
        byScene.set(key, row);
      }
      return row;
    };
    for (const row of eventRows) {
      const target = rowOf(row.scene === null || row.scene === undefined ? null : String(row.scene));
      const stage = String(row.stage) as LotteryEventStage;
      if (stage === "enter" || stage === "login" || stage === "bind") {
        target[stage] = Number(row.cnt);
      }
    }
    for (const row of participationRows) {
      const target = rowOf(row.scene === null || row.scene === undefined ? null : String(row.scene));
      target.draw = Number(row.draw_cnt);
      target.win = Number(row.win_cnt);
      target.verified = Number(row.verified_cnt);
    }
    return [...byScene.values()].sort((a, b) => {
      if (a.scene === null && b.scene !== null) return 1;
      if (a.scene !== null && b.scene === null) return -1;
      return (a.scene ?? "").localeCompare(b.scene ?? "");
    });
  }
}
