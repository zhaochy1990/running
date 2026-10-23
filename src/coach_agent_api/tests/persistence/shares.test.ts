import assert from "node:assert/strict";
import test from "node:test";
import { MySqlCoachDataDeleter } from "../../src/persistence/deletion.js";
import { MySqlCoachShareStore } from "../../src/persistence/shares.js";

/** 记录 SQL 的假 pool：query/execute 可按注册顺序回放预设结果。 */
class FakePool {
  readonly statements: { sql: string; values: unknown[] | undefined }[] = [];
  private readonly script: ((statement: { sql: string; values: unknown[] | undefined }, index: number) => unknown)[];

  constructor(script: ((statement: { sql: string; values: unknown[] | undefined }, index: number) => unknown)[] = []) {
    this.script = script;
  }

  async query(sql: string, values?: unknown[]): Promise<unknown> {
    return this.record(sql, values);
  }

  async execute(sql: string, values?: unknown[]): Promise<unknown> {
    return this.record(sql, values);
  }

  private record(sql: string, values: unknown[] | undefined): unknown {
    const index = this.statements.length;
    this.statements.push({ sql, values });
    return this.script[index]?.({ sql, values }, index) ?? [[], []];
  }
}

test("setup 幂等建 coach_shares 表（uk_selection 三元组唯一键）", async () => {
  const pool = new FakePool();
  await new MySqlCoachShareStore(pool as never).setup();
  assert.equal(pool.statements.length, 1);
  const sql = pool.statements[0]?.sql ?? "";
  assert.match(sql, /CREATE TABLE IF NOT EXISTS coach_shares/);
  assert.match(sql, /UNIQUE KEY uk_selection \(user_id, session_id, selection_hash\)/);
  assert.match(sql, /PRIMARY KEY \(sid\)/);
});

test("createOrGet：插入成功回读 uk 行命中自身 sid → reused:false", async () => {
  const inserted = new FakePool([
    () => [{ affectedRows: 1 }],
    () => [[{ sid: "newSidNewSidNewSidNew22", wxacode_url: null }]],
  ]);
  const store = new MySqlCoachShareStore(inserted as never);
  const created = await store.createOrGet({
    sid: "newSidNewSidNewSidNew22",
    userId: "u-1",
    sessionId: "s-1",
    selectionHash: "a".repeat(64),
    messageCount: 2,
    payload: { messages: [] },
    totalBytes: 100,
  });
  assert.deepEqual(created, { sid: "newSidNewSidNewSidNew22", reused: false, wxacodeUrl: null });
  const write = inserted.statements[0];
  assert.match(write?.sql ?? "", /INSERT INTO coach_shares/);
  assert.equal(write?.values?.[0], "newSidNewSidNewSidNew22");
  assert.equal(write?.values?.[5], '{"messages":[]}');
  assert.match(inserted.statements[1]?.sql ?? "", /WHERE user_id=\? AND session_id=\? AND selection_hash=\?/);
});

test("createOrGet：判据协议无关——affectedRows 不可靠（mysql2 默认 FOUND_ROWS 下重复无变更插入也报 1，#722），按回读 uk 行的 sid 判复用", async () => {
  for (const affectedRows of [0, 1, 2]) {
    const duplicated = new FakePool([
      () => [{ affectedRows }],
      () => [[{ sid: "existingSid12345678901", wxacode_url: "https://cos.example.com/x.png" }]],
    ]);
    const reused = await new MySqlCoachShareStore(duplicated as never).createOrGet({
      sid: "anotherSidAnotherSidAnothe",
      userId: "u-1",
      sessionId: "s-1",
      selectionHash: "a".repeat(64),
      messageCount: 2,
      payload: { messages: [] },
      totalBytes: 100,
    });
    assert.deepEqual(reused, { sid: "existingSid12345678901", reused: true, wxacodeUrl: "https://cos.example.com/x.png" });
  }
});

test("createOrGet：upsert 后回读不到行时抛错（read-your-write 违约）", async () => {
  const pool = new FakePool([() => [{ affectedRows: 1 }], () => [[]]]);
  await assert.rejects(
    new MySqlCoachShareStore(pool as never).createOrGet({
      sid: "missingRowMissingRowMiss",
      userId: "u-1",
      sessionId: "s-1",
      selectionHash: "a".repeat(64),
      messageCount: 1,
      payload: {},
      totalBytes: 10,
    }),
    /selection row missing after upsert/,
  );
});

test("getBySid：payload 兼容对象与 JSON 字符串两种驱动形态；无行返回 null", async () => {
  const asObject = new FakePool([
    () => [
      [
        {
          sid: "sid",
          user_id: "u-1",
          session_id: "s-1",
          selection_hash: "h",
          message_count: 1,
          payload: { messages: [{ role: "user", content: "hi" }], sharer_name: "小赵" },
          total_bytes: 50,
          wxacode_url: null,
          status: "active",
          created_at: new Date("2026-10-23T00:00:00Z"),
        },
      ],
    ],
  ]);
  const row = await new MySqlCoachShareStore(asObject as never).getBySid("sid");
  assert.equal(row?.payload.sharer_name, "小赵");
  assert.deepEqual(row?.payload.messages, [{ role: "user", content: "hi" }]);

  const asString = new FakePool([() => [[{ payload: '{"messages":[],"custom":1}' }]]]);
  const decoded = await new MySqlCoachShareStore(asString as never).getBySid("sid");
  assert.deepEqual(decoded?.payload, { messages: [], custom: 1 });

  const missing = new FakePool([() => [[]]]);
  assert.equal(await new MySqlCoachShareStore(missing as never).getBySid("sid"), null);

  const broken = new FakePool([() => [[{ payload: "{not json" }]]]);
  const fallback = await new MySqlCoachShareStore(broken as never).getBySid("sid");
  assert.deepEqual(fallback?.payload, {});
});

test("setWxacodeUrl 按 sid 更新", async () => {
  const pool = new FakePool();
  await new MySqlCoachShareStore(pool as never).setWxacodeUrl("sid", "https://cos/x.png");
  assert.match(pool.statements[0]?.sql ?? "", /UPDATE coach_shares SET wxacode_url=\? WHERE sid=\?/);
  assert.deepEqual(pool.statements[0]?.values, ["https://cos/x.png", "sid"]);
});

test("账号删除：deleteForUser 按精确 user_id 清 coach_shares", async () => {
  const pool = new FakePool();
  const deleted = await new MySqlCoachDataDeleter(pool as never).deleteForUser("athlete-1");
  const shareDelete = pool.statements.find((statement) => statement.sql.includes("coach_shares"));
  assert.ok(shareDelete, "coach_shares deletion statement missing");
  assert.equal(shareDelete.sql, "DELETE FROM coach_shares WHERE user_id = ?");
  assert.deepEqual(shareDelete.values, ["athlete-1"]);
  assert.equal(deleted.coach_shares, 0);
});
