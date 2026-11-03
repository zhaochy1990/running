import assert from "node:assert/strict";
import test from "node:test";
import { MySqlLotteryStore } from "../../src/persistence/lottery.js";

interface Statement {
  sql: string;
  values: unknown[] | undefined;
}

/** 记录 SQL 的假 pool：query/execute 按注册顺序回放预设结果；getConnection 支持事务。 */
class FakePool {
  readonly statements: Statement[] = [];
  private readonly script: ((statement: Statement, index: number) => unknown)[];
  readonly connection = new FakeConnection(this);

  constructor(script: ((statement: Statement, index: number) => unknown)[] = []) {
    this.script = script;
  }

  async query(sql: string, values?: unknown[]): Promise<unknown> {
    return this.record(sql, values);
  }

  async execute(sql: string, values?: unknown[]): Promise<unknown> {
    return this.record(sql, values);
  }

  async getConnection(): Promise<unknown> {
    return this.connection;
  }

  private record(sql: string, values?: unknown[]): unknown {
    const index = this.statements.length;
    this.statements.push({ sql, values });
    return this.script[index]?.(this.statements[index] as Statement, index) ?? [[], []];
  }
}

class FakeConnection {
  readonly calls: string[] = [];

  constructor(private readonly pool: FakePool) {}

  async beginTransaction(): Promise<void> {
    this.calls.push("begin");
  }

  async commit(): Promise<void> {
    this.calls.push("commit");
  }

  async rollback(): Promise<void> {
    this.calls.push("rollback");
  }

  release(): void {
    this.calls.push("release");
  }

  async execute(sql: string, values?: unknown[]): Promise<unknown> {
    this.calls.push("execute");
    return this.pool.execute(sql, values);
  }
}

test("setup 幂等建 4 张表；lottery_participations 三处唯一约束齐全", async () => {
  const pool = new FakePool();
  await new MySqlLotteryStore(pool as never).setup();
  assert.equal(pool.statements.length, 4);

  const ddl = pool.statements.map((statement) => statement.sql);
  assert.match(ddl[0] ?? "", /CREATE TABLE IF NOT EXISTS lottery_activities/);
  assert.match(ddl[1] ?? "", /CREATE TABLE IF NOT EXISTS lottery_prizes/);
  assert.match(ddl[2] ?? "", /CREATE TABLE IF NOT EXISTS lottery_participations/);
  assert.match(ddl[3] ?? "", /CREATE TABLE IF NOT EXISTS lottery_staff/);

  const participations = ddl[2] ?? "";
  assert.match(participations, /UNIQUE KEY uk_user_activity \(user_id, activity_id\)/);
  assert.match(participations, /UNIQUE KEY uk_activity_provider \(activity_id, provider_key\)/);
  assert.match(participations, /UNIQUE KEY uk_activity_code \(activity_id, code\)/);
  assert.match(participations, /prize_id BIGINT UNSIGNED NULL/);
  assert.match(participations, /code CHAR\(3\) NULL/);
  assert.match(participations, /verified_by VARCHAR\(128\) NULL/);

  // 奖池表为 P2 行锁扣库存预留 remaining 列。
  assert.match(ddl[1] ?? "", /remaining INT NOT NULL DEFAULT 0/);
});

test("createActivity：INSERT 后回读；解析 snake_case 行", async () => {
  const startAt = new Date("2026-12-01T02:00:00Z");
  const endAt = new Date("2026-12-02T02:00:00Z");
  const pool = new FakePool([
    () => [{ insertId: 7, affectedRows: 1 }],
    () => [
      [
        {
          id: 7,
          name: "上海站",
          start_at: startAt,
          end_at: endAt,
          enabled: 0,
          rules_text: "规则",
          hero_image: null,
          created_at: new Date("2026-11-01T00:00:00Z"),
          updated_at: new Date("2026-11-01T00:00:00Z"),
        },
      ],
    ],
  ]);
  const activity = await new MySqlLotteryStore(pool as never).createActivity({ name: "上海站", startAt, endAt, rulesText: "规则" });
  assert.equal(activity.id, 7);
  assert.equal(activity.enabled, false);
  assert.equal(activity.rulesText, "规则");
  assert.match(pool.statements[0]?.sql ?? "", /INSERT INTO lottery_activities \(name, start_at, end_at, rules_text, hero_image\)/);
  assert.deepEqual(pool.statements[0]?.values, ["上海站", startAt, endAt, "规则", null]);
});

test("replacePrizes：事务内 DELETE + 多行 INSERT，remaining 初始 = stock", async () => {
  const pool = new FakePool([
    () => [], // DELETE
    () => [{ insertId: 1, affectedRows: 2 }], // INSERT
    () => [
      [
        { id: 1, activity_id: 5, name: "一等奖", image_url: null, stock: 2, remaining: 2, weight: 1, is_fallback: 0 },
        { id: 2, activity_id: 5, name: "谢谢参与", image_url: null, stock: 0, remaining: 0, weight: 5, is_fallback: 1 },
      ],
    ], // listPrizes
  ]);
  const prizes = await new MySqlLotteryStore(pool as never).replacePrizes(5, [
    { name: "一等奖", stock: 2, weight: 1, isFallback: false },
    { name: "谢谢参与", stock: 0, weight: 5, isFallback: true },
  ]);
  assert.deepEqual(
    pool.connection.calls.slice(0, 4),
    ["begin", "execute", "execute", "commit"],
  );
  assert.ok(pool.connection.calls.includes("release"));
  assert.match(pool.statements[0]?.sql ?? "", /DELETE FROM lottery_prizes WHERE activity_id=\?/);
  assert.match(pool.statements[1]?.sql ?? "", /INSERT INTO lottery_prizes \(activity_id, name, image_url, stock, remaining, weight, is_fallback\) VALUES \(\?, \?, \?, \?, \?, \?, \?\), \(\?, \?, \?, \?, \?, \?, \?\)/);
  // 第二档 is_fallback 落 1，两档 remaining 都从 stock 起步。
  assert.deepEqual(pool.statements[1]?.values?.slice(7, 14), [5, "谢谢参与", null, 0, 0, 5, 1]);
  assert.equal(prizes[1]?.isFallback, true);
});

test("replacePrizes：INSERT 失败 → rollback 并向上抛", async () => {
  const pool = new FakePool([
    () => [], // DELETE
    () => {
      throw new Error("ER_DUP_ENTRY");
    },
  ]);
  await assert.rejects(
    new MySqlLotteryStore(pool as never).replacePrizes(5, [{ name: "一等奖", stock: 1, weight: 1, isFallback: false }]),
    /ER_DUP_ENTRY/,
  );
  assert.deepEqual(
    pool.connection.calls.filter((call) => call !== "execute"),
    ["begin", "rollback", "release"],
  );
});

test("setActivityEnabled / hasParticipations 的 SQL 形状", async () => {
  const pool = new FakePool([
    () => [{ affectedRows: 1 }], // UPDATE
    () => [[{ id: 5, name: "x", start_at: new Date(), end_at: new Date(), enabled: 1, rules_text: null, hero_image: null, created_at: new Date(), updated_at: new Date() }]], // 回读
    () => [[1]], // hasParticipations 命中
  ]);
  const store = new MySqlLotteryStore(pool as never);
  const enabled = await store.setActivityEnabled(5, true);
  assert.equal(enabled?.enabled, true);
  assert.match(pool.statements[0]?.sql ?? "", /UPDATE lottery_activities SET enabled=\? WHERE id=\?/);
  assert.deepEqual(pool.statements[0]?.values, [1, 5]);

  assert.equal(await store.hasParticipations(5), true);
  assert.match(pool.statements[2]?.sql ?? "", /SELECT 1 FROM lottery_participations WHERE activity_id=\? LIMIT 1/);
});
