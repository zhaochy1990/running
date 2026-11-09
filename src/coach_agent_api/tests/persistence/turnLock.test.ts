import assert from "node:assert/strict";
import test from "node:test";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { MySqlThreadLock } from "../../src/persistence/turns.js";
import { ThreadBusyError } from "../../src/turn/errors.js";

const DB_CONFIG = { host: "h", port: 3306, user: "u", password: "p", database: "d" };

/** Fake connection: GET_LOCK answers with queued values; queries and end() are recorded. */
function fakeConnection(answers: number[]) {
  const queries: { sql: string; values: unknown[] }[] = [];
  let ended = 0;
  const queue = [...answers];
  const connection = {
    async query(sql: string, values: unknown[]) {
      queries.push({ sql, values });
      return [[{ acquired: queue.shift() }] as RowDataPacket[], []];
    },
    async end() {
      ended += 1;
    },
  } as unknown as Connection;
  return { connection, queries, ended: () => ended };
}

test("lock acquisition passes the configured wait budget to GET_LOCK", async () => {
  const fake = fakeConnection([1]);
  const lock = new MySqlThreadLock(DB_CONFIG, 90, async () => fake.connection);
  const result = await lock.runExclusive("thread", async () => "ran");
  assert.equal(result, "ran");
  assert.equal(fake.queries[0]?.values[1], 90);
  // Held locks are released, and the dedicated connection is always closed.
  assert.ok(fake.queries.some((q) => q.sql.includes("RELEASE_LOCK")));
  assert.equal(fake.ended(), 1);
});

test("a lock that never frees fails busy after the budget without releasing", async () => {
  const fake = fakeConnection([0]);
  const lock = new MySqlThreadLock(DB_CONFIG, 0, async () => fake.connection);
  await assert.rejects(lock.runExclusive("thread", async () => "ran"), ThreadBusyError);
  assert.equal(fake.queries[0]?.values[1], 0);
  assert.ok(!fake.queries.some((q) => q.sql.includes("RELEASE_LOCK")));
  assert.equal(fake.ended(), 1);
});
