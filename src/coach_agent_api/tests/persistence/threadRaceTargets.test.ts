import assert from "node:assert/strict";
import test from "node:test";
import { MySqlThreadRaceTargetStore } from "../../src/persistence/threadRaceTargets.js";

interface Statement {
  sql: string;
  values: unknown[] | undefined;
}

/** 记录 SQL 的假 pool：query/execute 按注册顺序回放预设结果。 */
class FakePool {
  readonly statements: Statement[] = [];
  private readonly script: ((statement: Statement, index: number) => unknown)[];

  constructor(script: ((statement: Statement, index: number) => unknown)[] = []) {
    this.script = script;
  }

  async query(sql: string, values?: unknown[]): Promise<unknown> {
    return this.record(sql, values);
  }

  async execute(sql: string, values?: unknown[]): Promise<unknown> {
    return this.record(sql, values);
  }

  private record(sql: string, values?: unknown[]): unknown {
    const index = this.statements.length;
    this.statements.push({ sql, values });
    return this.script[index]?.(this.statements[index] as Statement, index) ?? [[], []];
  }
}

const CANDIDATES = [
  { race_event_id: 61, item_type: "HalfMarathon", name: "南通马拉松", race_date: "2026-11-08", city: "南通市" },
  { race_event_id: 61, item_type: "Marathon", name: "南通马拉松", race_date: "2026-11-08", city: "南通市" },
];

test("setup 建表 DDL 的时间列全部带显式默认（11-03 生产 1067 教训）", async () => {
  const pool = new FakePool([() => undefined]);
  const store = new MySqlThreadRaceTargetStore(pool as never);
  await store.setup();
  const ddl = pool.statements[0]?.sql ?? "";
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS coach_thread_race_targets/);
  assert.match(ddl, /updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP/);
  assert.doesNotMatch(ddl, /TIMESTAMP NOT NULL(?! DEFAULT)/);
});

test("bind 写入绑定值，get 回读同形 ref", async () => {
  const pool = new FakePool([
    () => undefined, // bind INSERT
    () => [[{ race_event_id: 61, item_type: "HalfMarathon" }]], // get SELECT
  ]);
  const store = new MySqlThreadRaceTargetStore(pool as never);
  await store.bind("u:coach:s1", { kind: "race", race_event_id: 61, item_type: "HalfMarathon" });
  assert.match(pool.statements[0]?.sql ?? "", /ON DUPLICATE KEY UPDATE race_event_id=VALUES\(race_event_id\)/);
  assert.deepEqual(await store.get("u:coach:s1"), { kind: "race", race_event_id: 61, item_type: "HalfMarathon" });
});

test("get 无绑定时返回 null；脏行（缺 item_type）也视为未绑定", async () => {
  const pool = new FakePool([
    () => [[]],
    () => [[{ race_event_id: 61, item_type: null }]],
  ]);
  const store = new MySqlThreadRaceTargetStore(pool as never);
  assert.equal(await store.get("u:coach:s1"), null);
  assert.equal(await store.get("u:coach:s2"), null);
});

test("rememberCandidates 只覆盖候选集 JSON，不触碰已存在的绑定列", async () => {
  const pool = new FakePool([() => undefined]);
  const store = new MySqlThreadRaceTargetStore(pool as never);
  await store.rememberCandidates("u:coach:s1", CANDIDATES);
  const statement = pool.statements[0];
  assert.match(statement?.sql ?? "", /candidates_json=VALUES\(candidates_json\)/);
  assert.doesNotMatch(statement?.sql ?? "", /race_event_id=VALUES/);
  assert.equal(statement?.values?.[0], "u:coach:s1");
  assert.deepEqual(JSON.parse(String(statement?.values?.[1])), CANDIDATES);
});

test("candidates 回读并校验形状：字符串与对象双形态兼容（mysql2 默认解析 JSON 列）", async () => {
  const good = JSON.stringify(CANDIDATES);
  const dirty = JSON.stringify([
    { race_event_id: 61, item_type: "HalfMarathon", name: "南通马拉松", race_date: "2026-11-08", city: null },
    { race_event_id: -1, item_type: "HalfMarathon", name: "坏行", race_date: "2026-11-08" },
    "not-an-object",
  ]);
  const pool = new FakePool([
    () => [[{ candidates_json: good }]], // 字符串形态
    () => [[{ candidates_json: CANDIDATES }]], // 对象形态（mysql2 parseJson 默认）
    () => [[{ candidates_json: dirty }]],
    () => [[{ candidates_json: null }]],
    () => [[{ candidates_json: "not-json{{" }]],
    () => [[]],
  ]);
  const store = new MySqlThreadRaceTargetStore(pool as never);
  assert.deepEqual(await store.candidates("a"), CANDIDATES);
  assert.deepEqual(await store.candidates("b"), CANDIDATES);
  assert.deepEqual(await store.candidates("c"), [
    { race_event_id: 61, item_type: "HalfMarathon", name: "南通马拉松", race_date: "2026-11-08", city: null },
  ]);
  assert.equal(await store.candidates("d"), null);
  assert.equal(await store.candidates("e"), null);
  assert.equal(await store.candidates("f"), null);
});
