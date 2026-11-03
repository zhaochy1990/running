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

// ── #865 drawParticipation：事务形状与唯一约束兜底 ────────────────────

/** DB 行形态（snake_case，prizeRow 映射前）。 */
const PHYSICAL_PRIZE_ROW = { id: 1, activity_id: 5, name: "一等奖", image_url: null, stock: 2, remaining: 2, weight: 1, is_fallback: 0 };
const FALLBACK_PRIZE_ROW = { id: 2, activity_id: 5, name: "谢谢参与", image_url: null, stock: 0, remaining: 0, weight: 5, is_fallback: 1 };

/** 映射后行形态（camelCase，allocate 收到的就是这种）。 */
const PHYSICAL_PRIZE = { id: 1, activityId: 5, name: "一等奖", imageUrl: null, stock: 2, remaining: 2, weight: 1, isFallback: false };
const FALLBACK_PRIZE = { id: 2, activityId: 5, name: "谢谢参与", imageUrl: null, stock: 0, remaining: 0, weight: 5, isFallback: true };

function drawnParticipationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 11,
    activity_id: 5,
    user_id: "user-1",
    openid: null,
    provider_key: "coros:runner@example.com",
    prize_id: 1,
    code: "042",
    status: "drawn",
    verified_by: null,
    verified_at: null,
    created_at: new Date("2026-11-03T10:00:00Z"),
    ...overrides,
  };
}

/** 固定 allocate：永远选 PHYSICAL_PRIZE，code 按调用序给 "042"/"007"。 */
function physicalAllocator(codes: string[]) {
  let call = 0;
  const seenOccupied: ReadonlySet<string>[] = [];
  return {
    seenOccupied,
    allocate: (_prizes: unknown, occupied: ReadonlySet<string>) => {
      seenOccupied.push(occupied);
      const code = codes[call++] ?? "099";
      return { prize: { ...PHYSICAL_PRIZE }, code };
    },
  };
}

test("drawParticipation：锁序 + INSERT 先于扣减 + commit 的 SQL 形状；行映射正确", async () => {
  const pool = new FakePool([
    () => [[]], // dedup FOR UPDATE：无已有参与
    () => [[{ ...PHYSICAL_PRIZE_ROW }, { ...FALLBACK_PRIZE_ROW }]], // prizes FOR UPDATE
    () => [[{ code: "007" }]], // occupied codes FOR UPDATE
    () => [{ insertId: 11, affectedRows: 1 }], // INSERT
    () => [{ affectedRows: 1 }], // UPDATE 扣减
    () => [[drawnParticipationRow()]], // commit 后 getParticipation 回读
    () => [[{ ...PHYSICAL_PRIZE_ROW }]], // getPrize
  ]);
  const allocator = physicalAllocator(["042"]);
  const result = await new MySqlLotteryStore(pool as never).drawParticipation({
    activityId: 5,
    userId: "user-1",
    providerKey: "coros:runner@example.com",
    allocate: allocator.allocate as never,
  });

  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") return;
  assert.equal(result.participation.code, "042");
  assert.equal(result.participation.providerKey, "coros:runner@example.com");
  assert.equal(result.prize.id, 1);

  const sql = pool.statements.map((statement) => statement.sql);
  // 固定锁序：参与行 FOR UPDATE → 奖品行 FOR UPDATE → 已占编号 FOR UPDATE。
  assert.match(sql[0] ?? "", /SELECT \* FROM lottery_participations WHERE activity_id=\? AND user_id=\? FOR UPDATE/);
  assert.match(sql[1] ?? "", /SELECT \* FROM lottery_prizes WHERE activity_id=\? FOR UPDATE/);
  assert.match(sql[2] ?? "", /SELECT code FROM lottery_participations WHERE activity_id=\? AND code IS NOT NULL FOR UPDATE/);
  // INSERT 先于扣减（失败尝试不在事务里留副作用）。
  assert.match(sql[3] ?? "", /INSERT INTO lottery_participations \(activity_id, user_id, provider_key, prize_id, code\) VALUES \(\?, \?, \?, \?, \?\)/);
  assert.deepEqual(pool.statements[3]?.values, [5, "user-1", "coros:runner@example.com", 1, "042"]);
  assert.match(sql[4] ?? "", /UPDATE lottery_prizes SET remaining = remaining - 1 WHERE id=\? AND remaining > 0/);
  assert.deepEqual(pool.statements[4]?.values, [1]);
  assert.deepEqual(
    pool.connection.calls.filter((call) => call !== "execute"),
    ["begin", "commit", "release"],
  );
});

test("drawParticipation：并发重放走 FOR UPDATE 命中已有行 → duplicate 返回已有结果", async () => {
  const pool = new FakePool([
    () => [[drawnParticipationRow()]], // dedup FOR UPDATE 命中
    () => [[{ ...PHYSICAL_PRIZE_ROW }]], // prizeOf 回读
  ]);
  const result = await new MySqlLotteryStore(pool as never).drawParticipation({
    activityId: 5,
    userId: "user-1",
    providerKey: "coros:runner@example.com",
    allocate: () => {
      throw new Error("must not allocate on replay");
    },
  });
  assert.equal(result.outcome, "duplicate");
  if (result.outcome === "duplicate") {
    assert.equal(result.participation.code, "042");
    assert.equal(result.prize?.id, 1);
  }
  // 读路径也走 commit 释放锁，无 rollback。
  assert.deepEqual(
    pool.connection.calls.filter((call) => call !== "execute"),
    ["begin", "commit", "release"],
  );
});

test("drawParticipation：uk_activity_provider 冲突 → rollback + provider_conflict", async () => {
  const pool = new FakePool([
    () => [[]],
    () => [[{ ...PHYSICAL_PRIZE_ROW }, { ...FALLBACK_PRIZE_ROW }]],
    () => [[]],
    () => {
      throw new Error("Duplicate entry '5-coros:runner@example.com' for key 'lottery_participations.uk_activity_provider'");
    },
  ]);
  const result = await new MySqlLotteryStore(pool as never).drawParticipation({
    activityId: 5,
    userId: "user-2",
    providerKey: "coros:runner@example.com",
    allocate: physicalAllocator(["042"]).allocate as never,
  });
  assert.equal(result.outcome, "provider_conflict");
  assert.deepEqual(
    pool.connection.calls.filter((call) => call !== "execute"),
    ["begin", "rollback", "release"],
  );
});

test("drawParticipation：INSERT 撞 uk_user_activity（并发竞态）→ 回读已有行返回 duplicate", async () => {
  const pool = new FakePool([
    () => [[]], // dedup 未命中（READ COMMITTED 下可能）
    () => [[{ ...PHYSICAL_PRIZE_ROW }, { ...FALLBACK_PRIZE_ROW }]],
    () => [[]],
    () => {
      throw new Error("Duplicate entry 'user-1-5' for key 'lottery_participations.uk_user_activity'");
    },
    () => [[drawnParticipationRow()]], // rollback 后回读
    () => [[{ ...PHYSICAL_PRIZE_ROW }]], // prizeOf
  ]);
  const result = await new MySqlLotteryStore(pool as never).drawParticipation({
    activityId: 5,
    userId: "user-1",
    providerKey: "coros:runner@example.com",
    allocate: physicalAllocator(["042"]).allocate as never,
  });
  assert.equal(result.outcome, "duplicate");
  assert.match(pool.statements[4]?.sql ?? "", /SELECT \* FROM lottery_participations WHERE activity_id=\? AND user_id=\?/);
});

test("drawParticipation：编号撞车（uk_activity_code）→ 换号重试且失败尝试无副作用", async () => {
  const pool = new FakePool([
    () => [[]],
    () => [[{ ...PHYSICAL_PRIZE_ROW }, { ...FALLBACK_PRIZE_ROW }]],
    () => [[{ code: "007" }]], // 已占用编号
    () => {
      throw new Error("Duplicate entry '5-007' for key 'lottery_participations.uk_activity_code'");
    },
    () => [{ insertId: 11, affectedRows: 1 }], // 第二次 INSERT 成功
    () => [{ affectedRows: 1 }], // 扣减（仅成功后一次）
    () => [[drawnParticipationRow({ code: "042" })]], // 回读
    () => [[{ ...PHYSICAL_PRIZE_ROW }]], // getPrize
  ]);
  const allocator = physicalAllocator(["007", "042"]);
  const result = await new MySqlLotteryStore(pool as never).drawParticipation({
    activityId: 5,
    userId: "user-1",
    providerKey: "coros:runner@example.com",
    allocate: allocator.allocate as never,
  });
  assert.equal(result.outcome, "created");
  // 重试的 allocate 看到撞车编号已入 occupied 集合。
  assert.equal(allocator.seenOccupied.length, 2);
  assert.equal(allocator.seenOccupied[1]?.has("007"), true);
  // 扣减只发生一次（成功 INSERT 之后），rollback/commit 一次成型。
  const updates = pool.statements.filter((statement) => /UPDATE lottery_prizes/.test(statement.sql));
  assert.equal(updates.length, 1);
  assert.deepEqual(
    pool.connection.calls.filter((call) => call !== "execute"),
    ["begin", "commit", "release"],
  );
});

test("drawParticipation：兜底档中奖 → code 落 null、不扣库存", async () => {
  const pool = new FakePool([
    () => [[]],
    () => [[{ ...PHYSICAL_PRIZE_ROW, remaining: 0 }, { ...FALLBACK_PRIZE_ROW }]], // 实物全空
    () => [[]],
    () => [{ insertId: 12, affectedRows: 1 }],
    () => [[drawnParticipationRow({ id: 12, prize_id: 2, code: null })]], // 回读
    () => [[{ ...FALLBACK_PRIZE_ROW }]], // getPrize
  ]);
  const result = await new MySqlLotteryStore(pool as never).drawParticipation({
    activityId: 5,
    userId: "user-1",
    providerKey: "coros:runner@example.com",
    allocate: () => ({ prize: { ...FALLBACK_PRIZE }, code: null }),
  });
  assert.equal(result.outcome, "created");
  if (result.outcome === "created") {
    assert.equal(result.participation.code, null);
    assert.equal(result.prize.isFallback, true);
  }
  assert.equal(pool.statements.some((statement) => /UPDATE lottery_prizes/.test(statement.sql)), false);
  assert.deepEqual(pool.statements[3]?.values, [5, "user-1", "coros:runner@example.com", 2, null]);
});

test("drawParticipation：实物档码空间耗尽（allocate 返回 null code）→ rollback 抛错", async () => {
  const pool = new FakePool([
    () => [[]],
    () => [[{ ...PHYSICAL_PRIZE_ROW }]],
    () => [[]],
  ]);
  await assert.rejects(
    new MySqlLotteryStore(pool as never).drawParticipation({
      activityId: 5,
      userId: "user-1",
      providerKey: "coros:runner@example.com",
      allocate: () => ({ prize: { ...PHYSICAL_PRIZE }, code: null }),
    }),
    /code space exhausted/,
  );
  assert.equal(pool.statements.some((statement) => /INSERT INTO lottery_participations/.test(statement.sql)), false);
  assert.deepEqual(
    pool.connection.calls.filter((call) => call !== "execute"),
    ["begin", "rollback", "release"],
  );
});

test("drawParticipation：扣减 affectedRows=0（库存消失，防御分支）→ rollback 抛错", async () => {
  const pool = new FakePool([
    () => [[]],
    () => [[{ ...PHYSICAL_PRIZE_ROW }]],
    () => [[]],
    () => [{ insertId: 11, affectedRows: 1 }], // INSERT 成功
    () => [{ affectedRows: 0 }], // 扣减守卫未命中
  ]);
  await assert.rejects(
    new MySqlLotteryStore(pool as never).drawParticipation({
      activityId: 5,
      userId: "user-1",
      providerKey: "coros:runner@example.com",
      allocate: physicalAllocator(["042"]).allocate as never,
    }),
    /ran out of stock/,
  );
  assert.deepEqual(
    pool.connection.calls.filter((call) => call !== "execute"),
    ["begin", "rollback", "release"],
  );
});
