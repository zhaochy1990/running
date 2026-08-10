import assert from "node:assert/strict";
import test from "node:test";

import {
  MasterPlanSchemaConflictError,
  upgradeMasterPlanSchema,
} from "../src/master-plan-schema.js";

function canonicalInspection(columns = ["revision"]) {
  return {
    columns,
    revisionColumn: columns.includes("revision")
      ? { data_type: "bigint", is_nullable: "YES" }
      : null,
    checks: {
      ck_master_plan_content_version: "content_version in (1,2)",
      ck_master_plan_revision:
        "((content_version = 1 and revision is null) or (content_version = 2 and revision >= 1))",
      ck_master_plan_current_marker:
        "((status = 'active' and active_flag = 1) or (status <> 'active' and active_flag is null))",
    },
    uniqueIndexes: {
      uidx_master_plan_active: ["user_id", "active_flag"],
    },
  };
}

function adapter(initial) {
  let inspection = initial;
  const events = [];
  return {
    events,
    async inspect() {
      events.push(["inspect", [...inspection.columns]]);
      return inspection;
    },
    async validateRows(revisionColumn) {
      events.push(["validate", revisionColumn]);
      return { valid: true, invalid_count: 0 };
    },
    async renameVersionAndReplaceChecks() {
      events.push(["upgrade"]);
      inspection = canonicalInspection(["revision"]);
    },
  };
}

test("version-only schema is upgraded once and then validates as a no-op", async () => {
  const io = adapter({
    ...canonicalInspection(["version"]),
    revisionColumn: null,
    checks: { ck_master_plan_v2_version: "content_version = 1 or version is not null" },
  });

  const upgraded = await upgradeMasterPlanSchema(io);
  const rerun = await upgradeMasterPlanSchema(io);

  assert.deepEqual(upgraded, { state: "upgraded", from: "version", to: "revision" });
  assert.deepEqual(rerun, { state: "validated", column: "revision" });
  assert.deepEqual(io.events, [
    ["inspect", ["version"]],
    ["validate", "version"],
    ["upgrade"],
    ["inspect", ["revision"]],
    ["validate", "revision"],
    ["inspect", ["revision"]],
    ["validate", "revision"],
  ]);
});

test("revision-only canonical schema validates without DDL", async () => {
  const inspection = canonicalInspection();
  inspection.checks.ck_master_plan_current_marker =
    "((status = _utf8mb4'active' and active_flag = 1) or (status <> _utf8mb4'active' and active_flag is null))";
  const io = adapter(inspection);
  assert.deepEqual(await upgradeMasterPlanSchema(io), {
    state: "validated",
    column: "revision",
  });
  assert.equal(io.events.some(([event]) => event === "upgrade"), false);
});

test("both or neither version columns are schema conflicts", async () => {
  for (const columns of [["version", "revision"], []]) {
    const io = adapter(canonicalInspection(columns));
    await assert.rejects(upgradeMasterPlanSchema(io), MasterPlanSchemaConflictError);
    assert.equal(io.events.some(([event]) => event === "upgrade"), false);
  }
});

test("revision-only state with missing constraints or invalid rows is a conflict", async () => {
  const missingCheck = adapter({
    ...canonicalInspection(),
    checks: { ck_master_plan_content_version: "content_version in (1,2)" },
  });
  await assert.rejects(upgradeMasterPlanSchema(missingCheck), /canonical constraints/i);

  const wrongCheck = adapter({
    ...canonicalInspection(),
    checks: {
      ...canonicalInspection().checks,
      ck_master_plan_revision: "revision is not null",
    },
  });
  await assert.rejects(upgradeMasterPlanSchema(wrongCheck), /canonical constraints/i);

  const weakenedCheck = adapter({
    ...canonicalInspection(),
    checks: {
      ...canonicalInspection().checks,
      ck_master_plan_revision:
        "((content_version = 1 and revision is null) or (content_version = 2 and revision >= 1) or 1 = 1)",
    },
  });
  await assert.rejects(upgradeMasterPlanSchema(weakenedCheck), /canonical constraints/i);

  const invalidRows = adapter(canonicalInspection());
  invalidRows.validateRows = async () => ({ valid: false, invalid_count: 2 });
  await assert.rejects(upgradeMasterPlanSchema(invalidRows), /invalid rows/i);
});
