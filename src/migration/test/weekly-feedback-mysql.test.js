import assert from "node:assert/strict";
import test from "node:test";

import { createWeeklyFeedbackTarget } from "../src/weekly-feedback-mysql.js";

test("MySQL target binds reads and inserts and commits a successful transaction", async () => {
  const calls = [];
  const conn = {
    async execute(sql, values) {
      calls.push(["execute", sql, values]);
      if (sql.startsWith("SELECT DATABASE")) return [[{ database_name: "stride", server_uuid: "server-1" }]];
      return [[]];
    },
    async beginTransaction() { calls.push(["begin"]); },
    async commit() { calls.push(["commit"]); },
    async rollback() { calls.push(["rollback"]); },
  };
  const target = createWeeklyFeedbackTarget(conn);
  assert.deepEqual(await target.getIdentity(), { database_name: "stride", server_uuid: "server-1" });
  await target.listWeeklyFeedback("user");
  await target.transaction(async (tx) => {
    await tx.insertWeeklyFeedback({ user_id: "user", week_start: "2026-01-05", content_md: "", created_at: "2026-01-05 00:00:00.000", updated_at: "2026-01-05 00:00:00.000" });
    await tx.listWeeklyFeedback("user");
  });
  assert.deepEqual(calls.map((call) => call[0]), ["execute", "execute", "execute", "begin", "execute", "execute", "commit"]);
  assert.equal(calls[2][1], "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  assert.match(calls[1][1], /WHERE user_id = \?/);
  assert.match(calls[1][1], /DATE_FORMAT\(week_start/);
  assert.match(calls[1][1], /DATE_FORMAT\(created_at/);
  assert.match(calls[4][1], /^INSERT INTO weekly_feedback/);
  assert.match(calls[5][1], /FOR UPDATE$/);
  assert.equal(calls.some((call) => call[0] === "rollback"), false);
});

test("MySQL target rolls back transaction failures", async () => {
  const calls = [];
  const conn = {
    async execute(sql) { calls.push(sql); return [[]]; },
    async beginTransaction() { calls.push("begin"); },
    async commit() { calls.push("commit"); },
    async rollback() { calls.push("rollback"); },
  };
  const target = createWeeklyFeedbackTarget(conn);
  await assert.rejects(target.transaction(async () => { throw new Error("boom"); }));
  assert.deepEqual(calls, ["SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", "begin", "rollback"]);
});
