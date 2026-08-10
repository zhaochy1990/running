import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  emptyReport,
  normalizeRunningAge,
  runRunningAgeMigration,
  runningAgeFromJson,
} from "../src/migrate-running-age.js";
import { RUNNING_AGE_UPDATE_SQL } from "../src/mysql.js";
import { selectUserIds } from "../src/profiles.js";

const REAL = ["11111111-1111-4111-8111-111111111111"];
const UUID = REAL[0];

function sourceDir() {
  return mkdtempSync(join("/tmp", "stride-running-age-"));
}

function writeSource(dataDir, userId, value) {
  mkdirSync(join(dataDir, userId), { recursive: true });
  writeFileSync(
    join(dataDir, userId, "running_profile.json"),
    JSON.stringify({ current: value }),
  );
}

test("running-age transform normalizes legacy lt6m and tolerates range key", () => {
  assert.equal(normalizeRunningAge("lt6m"), "lt_6m");
  assert.equal(runningAgeFromJson({ current: { running_age: "lt6m" } }), "lt_6m");
  assert.equal(
    runningAgeFromJson({ current: { running_age_range: "6m_1y" } }),
    "6m_1y",
  );
  assert.equal(runningAgeFromJson({ current: { running_age: "unknown" } }), null);
  assert.equal(runningAgeFromJson({ current: { injuries: ["knee"] } }), null);
});

test("selection accepts UUIDs and aliases only within the real-user allowlist", () => {
  assert.deepEqual(
    selectUserIds(REAL, ["runner", UUID], Infinity, { runner: UUID }),
    { ids: [UUID], rejected: [] },
  );
  assert.deepEqual(
    selectUserIds(
      REAL,
      ["test", "other"],
      Infinity,
      { test: "00000000-0000-4000-8000-000000000000" },
    ),
    { ids: [], rejected: ["test", "other"] },
  );
});

test("dry-run reports candidates without a connection or source content", async () => {
  const dataDir = sourceDir();
  writeSource(dataDir, UUID, { running_age: "1y_3y", injuries: ["ignored"] });
  const report = await runRunningAgeMigration({
    dataDir,
    requested: [UUID],
    commit: false,
    allowlist: REAL,
  });
  assert.deepEqual(report, { migrated: 1, skipped: 0, missing: 0, failed: 0 });
});

test("commit counts conditional updates, skips, missing, and failures", async () => {
  const dataDir = sourceDir();
  const skipped = "22222222-2222-4222-8222-222222222222";
  const missing = "33333333-3333-4333-8333-333333333333";
  const invalid = "44444444-4444-4444-8444-444444444444";
  const allowlist = [UUID, skipped, missing, invalid];
  writeSource(dataDir, UUID, { running_age: "6m_1y" });
  writeSource(dataDir, skipped, { running_age: "1y_3y" });
  writeSource(dataDir, invalid, { running_age: "unknown", injuries: ["ignored"] });
  const calls = [];
  const connection = {
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith("UPDATE")) {
        return [{ affectedRows: params[2] === skipped ? 0 : 1 }];
      }
      throw new Error("unexpected SQL");
    },
  };
  const report = await runRunningAgeMigration({
    dataDir,
    requested: allowlist,
    commit: true,
    connection,
    allowlist,
  });
  assert.deepEqual(report, { migrated: 1, skipped: 1, missing: 1, failed: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].sql, RUNNING_AGE_UPDATE_SQL);
  assert.match(calls[0].sql, /WHERE user_id = \? AND running_age_range = 'unknown'/);
  assert.deepEqual(calls[0].params.slice(0, 2), ["6m_1y", calls[0].params[1]]);
});

test("empty report has only count fields", () => {
  assert.deepEqual(emptyReport(), { migrated: 0, skipped: 0, missing: 0, failed: 0 });
});
