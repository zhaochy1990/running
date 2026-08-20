import assert from "node:assert/strict";
import test from "node:test";

import {
  createMasterPlanSchemaAdapter,
  createMasterPlanTarget,
} from "../src/master-plan-mysql.js";
import { upgradeMasterPlanSchema } from "../src/master-plan-schema.js";

const USER_ID = "11111111-2222-4333-8444-555555555555";

function fakeConnection(responses = []) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    async execute(sql, values = []) {
      calls.push(["execute", sql, values]);
      return [queue.shift() ?? [], []];
    },
    async query(sql, values = []) {
      calls.push(["query", sql, values]);
      return [queue.shift() ?? [], []];
    },
    async beginTransaction() { calls.push(["begin"]); },
    async commit() { calls.push(["commit"]); },
    async rollback() { calls.push(["rollback"]); },
  };
}

test("target discovers every current candidate through either marker", async () => {
  const rows = [
    { plan_id: "plan-a", status: "active", active_flag: null, version: 2 },
    { plan_id: "plan-b", status: "archived", active_flag: 1, version: null },
  ];
  const conn = fakeConnection([rows]);
  const target = createMasterPlanTarget(conn, { revisionColumn: "version" });
  const actual = await target.listCurrentMasterPlans(USER_ID);

  assert.equal(actual[0].revision, 2);
  assert.equal(actual[1].revision, null);
  const [, sql, values] = conn.calls[0];
  assert.match(sql, /active_flag\s*=\s*1\s+OR\s+status\s*=\s*'active'/i);
  assert.match(sql, /version\s+AS\s+revision/i);
  assert.deepEqual(values, [USER_ID]);
});

test("target writes insert-only rows in a per-user transaction", async () => {
  const conn = fakeConnection();
  const target = createMasterPlanTarget(conn);
  await target.transaction(USER_ID, async (tx) => {
    await tx.insertMasterPlan({
      plan_id: "plan-a",
      user_id: USER_ID,
      content_version: 2,
      content: "{}",
      goal_id: "goal-a",
      status: "active",
      active_flag: 1,
      revision: 3,
      created_at: "2026-08-01 00:00:00.000",
      updated_at: "2026-08-02 00:00:00.000",
    });
  });

  assert.deepEqual(conn.calls.map(([kind]) => kind), ["begin", "execute", "commit"]);
  const sql = conn.calls[1][1];
  assert.match(sql, /^INSERT INTO master_plan/i);
  assert.match(sql, /revision/);
  assert.doesNotMatch(sql, /ON DUPLICATE KEY UPDATE/i);
});

test("target rolls back a failed user transaction", async () => {
  const conn = fakeConnection();
  const target = createMasterPlanTarget(conn);
  await assert.rejects(
    target.transaction(USER_ID, async () => { throw new Error("write failed"); }),
    /write failed/,
  );
  assert.deepEqual(conn.calls.map(([kind]) => kind), ["begin", "rollback"]);
});

test("schema adapter inspects columns, checks, and active unique index", async () => {
  const conn = fakeConnection([
    [
      { column_name: "revision", data_type: "bigint", is_nullable: "YES" },
      { column_name: "content", data_type: "longtext", is_nullable: "NO" },
    ],
    [{ constraint_name: "ck_master_plan_revision", check_clause: "content_version = 1 or revision is not null" }],
    [
      { index_name: "uidx_master_plan_active", non_unique: 0, seq_in_index: 1, column_name: "user_id" },
      { index_name: "uidx_master_plan_active", non_unique: 0, seq_in_index: 2, column_name: "active_flag" },
    ],
  ]);
  const adapter = createMasterPlanSchemaAdapter(conn);
  const inspection = await adapter.inspect();
  assert.deepEqual(inspection.columns, ["revision", "content"]);
  assert.deepEqual(inspection.revisionColumn, {
    column_name: "revision",
    data_type: "bigint",
    is_nullable: "YES",
  });
  assert.equal(inspection.checks.ck_master_plan_revision.includes("revision"), true);
  assert.deepEqual(inspection.uniqueIndexes.uidx_master_plan_active, ["user_id", "active_flag"]);
});

test("schema adapter normalizes uppercase information_schema metadata keys", async () => {
  const conn = fakeConnection([
    [
      { COLUMN_NAME: "version", DATA_TYPE: "bigint", IS_NULLABLE: "YES" },
      { COLUMN_NAME: "content", DATA_TYPE: "longtext", IS_NULLABLE: "NO" },
    ],
    [
      { CONSTRAINT_NAME: "ck_master_plan_content_version", CHECK_CLAUSE: "content_version in (1, 2)" },
      { CONSTRAINT_NAME: "ck_master_plan_v2_version", CHECK_CLAUSE: "content_version = 1 or version is not null" },
    ],
    [
      { INDEX_NAME: "uidx_master_plan_active", NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: "user_id" },
      { INDEX_NAME: "uidx_master_plan_active", NON_UNIQUE: 0, SEQ_IN_INDEX: 2, COLUMN_NAME: "active_flag" },
    ],
  ]);
  const inspection = await createMasterPlanSchemaAdapter(conn).inspect();
  assert.deepEqual(inspection.columns, ["version", "content"]);
  assert.equal(inspection.revisionColumn, null);
  assert.equal(inspection.checks.ck_master_plan_v2_version.includes("version"), true);
  assert.deepEqual(inspection.uniqueIndexes.uidx_master_plan_active, ["user_id", "active_flag"]);
});

test("schema adapter drops uppercase check names during rename", async () => {
  const conn = fakeConnection([[
    { CONSTRAINT_NAME: "ck_master_plan_content_version" },
    { CONSTRAINT_NAME: "ck_master_plan_v2_version" },
  ]]);
  await createMasterPlanSchemaAdapter(conn).renameVersionAndReplaceChecks();
  const ddl = conn.calls[1][1];
  assert.match(ddl, /DROP CHECK ck_master_plan_content_version/i);
  assert.match(ddl, /DROP CHECK ck_master_plan_v2_version/i);
});

test("revision-only real adapter metadata validates without DDL", async () => {
  const conn = fakeConnection([
    [
      { column_name: "revision", data_type: "bigint", is_nullable: "YES" },
      { column_name: "content", data_type: "longtext", is_nullable: "NO" },
    ],
    [
      { constraint_name: "ck_master_plan_content_version", check_clause: "content_version in (1, 2)" },
      {
        constraint_name: "ck_master_plan_revision",
        check_clause: "(content_version = 1 and revision is null) or (content_version = 2 and revision >= 1)",
      },
      {
        constraint_name: "ck_master_plan_current_marker",
        check_clause: "(status = 'active' and active_flag = 1) or (status <> 'active' and active_flag is null)",
      },
    ],
    [
      { index_name: "uidx_master_plan_active", non_unique: 0, seq_in_index: 1, column_name: "user_id" },
      { index_name: "uidx_master_plan_active", non_unique: 0, seq_in_index: 2, column_name: "active_flag" },
    ],
    [{ invalid_count: 0 }],
  ]);
  const result = await upgradeMasterPlanSchema(createMasterPlanSchemaAdapter(conn));
  assert.deepEqual(result, { state: "validated", column: "revision" });
  assert.equal(conn.calls.some(([kind]) => kind === "query"), false);
});

test("schema adapter performs one explicit rename and check replacement", async () => {
  const conn = fakeConnection([
    [
      { constraint_name: "ck_master_plan_content_version" },
      { constraint_name: "ck_master_plan_v2_version" },
    ],
  ]);
  const adapter = createMasterPlanSchemaAdapter(conn);
  await adapter.renameVersionAndReplaceChecks();
  const ddl = conn.calls[1][1];
  assert.match(ddl, /CHANGE COLUMN version revision BIGINT NULL/i);
  assert.match(ddl, /DROP CHECK ck_master_plan_v2_version/i);
  assert.match(ddl, /DROP CHECK ck_master_plan_content_version/i);
  assert.match(ddl, /ADD CONSTRAINT ck_master_plan_content_version CHECK/i);
  assert.match(ddl, /ADD CONSTRAINT ck_master_plan_revision CHECK/i);
  assert.match(ddl, /ADD CONSTRAINT ck_master_plan_current_marker CHECK/i);
});
