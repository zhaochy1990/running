/**
 * #867 lottery staff whitelist + funnel store SQL-shape tests (FakePool replay,
 * same style as persistence/lottery.test.ts — no real MySQL).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MySqlLotteryFunnelStore } from "../../src/persistence/lotteryFunnel.js";
import { MySqlLotteryStaffStore } from "../../src/persistence/lotteryStaff.js";

interface Statement {
  sql: string;
  values: unknown[] | undefined;
}

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

test("staff setup 幂等建表（与 lottery 域同一 DDL）", async () => {
  const pool = new FakePool();
  await new MySqlLotteryStaffStore(pool as never).setup();
  assert.equal(pool.statements.length, 1);
  assert.match(pool.statements[0]?.sql ?? "", /CREATE TABLE IF NOT EXISTS lottery_staff/);
  assert.match(pool.statements[0]?.sql ?? "", /KEY idx_openid \(openid\)/);
});

test("addStaff：INSERT + 回读；listStaff 两种口径的 SQL 形状", async () => {
  const createdAt = new Date("2026-11-03T02:00:00Z");
  const row = { id: 4, openid: "oX-9", activity_id: 3, note: "东门", created_at: createdAt };
  const pool = new FakePool([
    () => [{ insertId: 4, affectedRows: 1 }], // INSERT
    () => [[row]], // 回读
    () => [[row]], // listStaff（全量）
  ]);
  const store = new MySqlLotteryStaffStore(pool as never);
  const added = await store.addStaff({ openid: "oX-9", activityId: 3, note: "东门" });
  assert.equal(added.id, 4);
  assert.equal(added.activityId, 3);
  assert.match(pool.statements[0]?.sql ?? "", /INSERT INTO lottery_staff \(openid, activity_id, note\) VALUES \(\?, \?, \?\)/);
  assert.deepEqual(pool.statements[0]?.values, ["oX-9", 3, "东门"]);

  const all = await store.listStaff();
  assert.equal(all.length, 1);
  assert.match(pool.statements[2]?.sql ?? "", /SELECT \* FROM lottery_staff ORDER BY/);

  // 活动过滤口径：全局行 OR 该活动。
  const scoped = new FakePool([() => [[]]]);
  await new MySqlLotteryStaffStore(scoped as never).listStaff(3);
  assert.match(scoped.statements[0]?.sql ?? "", /WHERE activity_id IS NULL OR activity_id=\?/);
  assert.deepEqual(scoped.statements[0]?.values, [3]);
});

test("removeStaff：按 id DELETE，affectedRows 决定布尔", async () => {
  const hit = new FakePool([() => [{ affectedRows: 1 }]]);
  assert.equal(await new MySqlLotteryStaffStore(hit as never).removeStaff(4), true);
  const miss = new FakePool([() => [{ affectedRows: 0 }]]);
  assert.equal(await new MySqlLotteryStaffStore(miss as never).removeStaff(9), false);
  assert.match(miss.statements[0]?.sql ?? "", /DELETE FROM lottery_staff WHERE id=\?/);
});

test("funnel setup 幂等建 lottery_events（activity+stage 索引）", async () => {
  const pool = new FakePool();
  await new MySqlLotteryFunnelStore(pool as never).setup();
  assert.match(pool.statements[0]?.sql ?? "", /CREATE TABLE IF NOT EXISTS lottery_events/);
  assert.match(pool.statements[0]?.sql ?? "", /KEY idx_activity_stage \(activity_id, stage\)/);
});

test("recordEvent：INSERT 事件行（scene/user 可空）", async () => {
  const pool = new FakePool([() => [{ insertId: 1, affectedRows: 1 }]]);
  await new MySqlLotteryFunnelStore(pool as never).recordEvent({ activityId: 3, stage: "enter", scene: "01", userId: null });
  assert.match(pool.statements[0]?.sql ?? "", /INSERT INTO lottery_events \(activity_id, scene, stage, user_id\) VALUES \(\?, \?, \?, \?\)/);
  assert.deepEqual(pool.statements[0]?.values, [3, "01", "enter", null]);
});

test("funnelByScene：事件次数 × 参与人数合并到 scene 行；NULL scene 排最后", async () => {
  const pool = new FakePool([
    // 事件侧：scene 分组计数
    () => [
      [
        { scene: "01", stage: "enter", cnt: 120 },
        { scene: "01", stage: "login", cnt: 80 },
        { scene: "01", stage: "bind", cnt: 60 },
        { scene: null, stage: "enter", cnt: 5 },
        { scene: "02", stage: "enter", cnt: 40 },
      ],
    ],
    // 参与侧：draw/win/verified
    () => [
      [
        { scene: "01", draw_cnt: 55, win_cnt: 12, verified_cnt: 10 },
        { scene: "02", draw_cnt: 20, win_cnt: 4, verified_cnt: 4 },
        { scene: null, draw_cnt: 5, win_cnt: 1, verified_cnt: 1 },
      ],
    ],
  ]);
  const scenes = await new MySqlLotteryFunnelStore(pool as never).funnelByScene(3);

  assert.match(pool.statements[0]?.sql ?? "", /FROM lottery_events\s+WHERE activity_id=\? AND stage IN \('enter','login','bind'\) GROUP BY scene, stage/);
  assert.match(pool.statements[1]?.sql ?? "", /SUM\(code IS NOT NULL\) AS win_cnt/);
  assert.match(pool.statements[1]?.sql ?? "", /SUM\(verified_at IS NOT NULL\) AS verified_cnt/);

  assert.deepEqual(scenes, [
    { scene: "01", enter: 120, login: 80, bind: 60, draw: 55, win: 12, verified: 10 },
    { scene: "02", enter: 40, login: 0, bind: 0, draw: 20, win: 4, verified: 4 },
    { scene: null, enter: 5, login: 0, bind: 0, draw: 5, win: 1, verified: 1 },
  ]);
  // NULL scene（直链）排最后。
  assert.equal(scenes[scenes.length - 1]?.scene, null);
});
