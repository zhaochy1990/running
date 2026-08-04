import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMasterPlanConfig,
  rewriteGoalIdInJson,
  rewriteUserGoalId,
} from "../src/masterplan-azure.js";

const OLD = "s1-2026-chengdu-fm";
const NEW = "11111111-2222-4333-8444-555555555555";

test("parseMasterPlanConfig defaults the table names and derives versions", () => {
  const c = parseMasterPlanConfig({
    STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL: "https://acct.table.core.windows.net/",
  });
  assert.equal(c.accountUrl, "https://acct.table.core.windows.net/");
  assert.equal(c.tableName, "stridemasterplan");
  assert.equal(c.versionsTableName, "stridemasterplanversions");
});

test("parseMasterPlanConfig honours an override table name and empty account", () => {
  const c = parseMasterPlanConfig({ STRIDE_MASTER_PLAN_TABLE_NAME: "custommp" });
  assert.equal(c.accountUrl, "");
  assert.equal(c.tableName, "custommp");
  assert.equal(c.versionsTableName, "custommpversions");
});

test("rewriteGoalIdInJson rewrites the embedded .goal.goal_id and preserves the rest", () => {
  const src = JSON.stringify({
    plan_id: "p1",
    user_id: "u1",
    goal: { goal_id: OLD, race_name: "成都马拉松", distance: "FM" },
    weeks: [{ n: 1 }],
  });
  const { json, changed } = rewriteGoalIdInJson(src, OLD, NEW);
  assert.equal(changed, true);
  const doc = JSON.parse(json);
  assert.equal(doc.goal.goal_id, NEW);
  assert.equal(doc.goal.race_name, "成都马拉松");
  assert.equal(doc.plan_id, "p1");
  assert.deepEqual(doc.weeks, [{ n: 1 }]);
});

test("rewriteGoalIdInJson rewrites a legacy top-level goal_id", () => {
  const src = JSON.stringify({ plan_id: "p1", goal_id: OLD });
  const { json, changed } = rewriteGoalIdInJson(src, OLD, NEW);
  assert.equal(changed, true);
  assert.equal(JSON.parse(json).goal_id, NEW);
});

test("rewriteGoalIdInJson is idempotent when the id is already new (or absent)", () => {
  const already = JSON.stringify({ goal: { goal_id: NEW } });
  const r1 = rewriteGoalIdInJson(already, OLD, NEW);
  assert.equal(r1.changed, false);
  assert.equal(r1.json, already);

  const other = JSON.stringify({ goal: { goal_id: "someone-else" } });
  const r2 = rewriteGoalIdInJson(other, OLD, NEW);
  assert.equal(r2.changed, false);
});

test("rewriteGoalIdInJson throws on invalid JSON", () => {
  assert.throws(() => rewriteGoalIdInJson("not json", OLD, NEW), /not valid JSON/);
});

// ── orchestration over injected fake TableClients ───────────────────────────

function fakeClient(entities) {
  const updates = [];
  return {
    updates,
    listEntities() {
      return (async function* () {
        for (const e of entities) yield e;
      })();
    },
    async updateEntity(entity, mode) {
      updates.push({ entity, mode });
    },
  };
}

function fixtures(goalId) {
  const plans = fakeClient([
    {
      partitionKey: "u1",
      rowKey: "plan-1",
      plan_json: JSON.stringify({ plan_id: "plan-1", goal: { goal_id: goalId } }),
    },
  ]);
  const versions = fakeClient([
    {
      partitionKey: "plan-1",
      rowKey: "v1",
      snapshot_json: JSON.stringify({ plan_id: "plan-1", goal: { goal_id: goalId } }),
    },
  ]);
  return { plans, versions };
}

test("rewriteUserGoalId commits a Merge update to both plans and versions", async () => {
  const clients = fixtures(OLD);
  const stats = await rewriteUserGoalId(clients, "u1", OLD, NEW, { commit: true });
  assert.deepEqual(stats, {
    plansScanned: 1,
    plansRewritten: 1,
    versionsScanned: 1,
    versionsRewritten: 1,
  });
  assert.equal(clients.plans.updates.length, 1);
  assert.equal(clients.plans.updates[0].mode, "Merge");
  assert.equal(
    JSON.parse(clients.plans.updates[0].entity.plan_json).goal.goal_id,
    NEW,
  );
  assert.equal(clients.versions.updates.length, 1);
  assert.equal(
    JSON.parse(clients.versions.updates[0].entity.snapshot_json).goal.goal_id,
    NEW,
  );
});

test("rewriteUserGoalId dry-run counts but writes nothing", async () => {
  const clients = fixtures(OLD);
  const stats = await rewriteUserGoalId(clients, "u1", OLD, NEW, { commit: false });
  assert.equal(stats.plansRewritten, 1);
  assert.equal(stats.versionsRewritten, 1);
  assert.equal(clients.plans.updates.length, 0);
  assert.equal(clients.versions.updates.length, 0);
});

test("rewriteUserGoalId is a no-op when snapshots already hold the new id", async () => {
  const clients = fixtures(NEW);
  const stats = await rewriteUserGoalId(clients, "u1", OLD, NEW, { commit: true });
  assert.equal(stats.plansRewritten, 0);
  assert.equal(stats.versionsRewritten, 0);
  assert.equal(clients.plans.updates.length, 0);
  assert.equal(clients.versions.updates.length, 0);
});
