import assert from "node:assert/strict";
import test from "node:test";

import {
  FeedbackManifestError,
  applyWeeklyFeedbackManifest,
  buildWeeklyFeedbackManifest,
  parseFeedbackWeek,
} from "../src/weekly-feedback-migration.js";

const USER = "11111111-2222-4333-8444-555555555555";
const TS1 = "2025-12-29 01:02:03.000";
const TS2 = "2026-01-04 05:06:07.000";

function sqlite(overrides = {}) {
  return { week: "2025-12-29_01-04(P1W1)", content_md: " sqlite ", created_at: TS1, updated_at: TS2, ...overrides };
}

function markdown(overrides = {}) {
  return { folder: "2025-12-29_01-04(P1W1)", name: "feedback.md", text: " markdown ", lastModified: "2026-01-04T05:06:07Z", ...overrides };
}

function adapters({ sqliteRows = [], markdownRows = [], targetRows = [] } = {}) {
  const writes = [];
  const source = {
    async listSQLite() { return sqliteRows.map((row) => ({ ...row })); },
    async listMarkdown() { return markdownRows.map((row) => ({ ...row })); },
  };
  const target = {
    async getIdentity() { return { database_name: "stride", server_uuid: "server-1" }; },
    async listWeeklyFeedback() { return targetRows.map((row) => ({ ...row })); },
    async transaction(operation) {
      const before = targetRows.map((row) => ({ ...row }));
      try {
        return await operation({
          async getIdentity() { return target.getIdentity(); },
          async insertWeeklyFeedback(row) { writes.push({ ...row }); targetRows.push({ ...row }); },
          async listWeeklyFeedback() { return targetRows.map((row) => ({ ...row })); },
        });
      } catch (error) {
        targetRows.splice(0, targetRows.length, ...before);
        throw error;
      }
    },
  };
  return { source, target, writes, targetRows };
}

test("strict legacy week parsing accepts Monday-Sunday cross-year and rejects malformed suffixes", () => {
  assert.equal(parseFeedbackWeek("2025-12-29_01-04(P1W1)"), "2025-12-29");
  for (const value of [
    "2025-12-30_01-05(P1W1)",
    "2025-12-29_01-05(P1W1)",
    "2025-12-29_01-04suffix",
    "2025-12-29_01-04()",
    "2025-12-29_01-04(P1W1)/extra",
  ]) assert.equal(parseFeedbackWeek(value), null, value);
});

test("dry-run selects SQLite before Markdown, preserves timestamps, and performs no writes", async () => {
  const io = adapters({ sqliteRows: [sqlite()], markdownRows: [markdown()] });
  const manifest = await buildWeeklyFeedbackManifest({ userIds: [USER], source: io.source, target: io.target });
  assert.equal(manifest.error_count, 0);
  assert.deepEqual(manifest.users, [USER]);
  assert.deepEqual(manifest.candidates.map(({ source_kind, selected }) => ({ source_kind, selected })), [
    { source_kind: "sqlite", selected: true },
    { source_kind: "markdown", selected: false },
  ]);
  assert.equal(manifest.records.length, 1);
  assert.deepEqual(manifest.records[0], {
    user_id: USER, week_start: "2025-12-29", source_kind: "sqlite",
    source_ref: "2025-12-29_01-04(P1W1)", content_hash: manifest.records[0].content_hash,
    target_hash: null, created_at: TS1, updated_at: TS2,
    action: "insert", reason: "target_missing",
  });
  assert.match(manifest.records[0].content_hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(io.writes, []);
  assert.equal(JSON.stringify(manifest).includes(" sqlite "), false);
});

test("Markdown is fallback only without a SQLite row and whitespace content becomes empty", async () => {
  const io = adapters({ markdownRows: [markdown({ text: " \n\t " })] });
  const manifest = await buildWeeklyFeedbackManifest({ userIds: [USER], source: io.source, target: io.target });
  assert.equal(manifest.records[0].source_kind, "markdown");
  assert.equal(manifest.records[0].content_hash, "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(manifest.records[0].created_at, "2026-01-04 05:06:07.000");
  assert.equal(manifest.error_count, 0);
});

test("duplicates and missing or invalid required timestamps are blocking conflicts", async () => {
  const cases = [
    { sqliteRows: [sqlite(), sqlite({ week: "2025-12-29_01-04(other)" })], reason: "duplicate_normalized_week" },
    { sqliteRows: [sqlite({ created_at: null })], reason: "invalid_timestamp" },
    { sqliteRows: [sqlite({ updated_at: "not-a-time" })], reason: "invalid_timestamp" },
    { sqliteRows: [sqlite({ created_at: "0" })], reason: "invalid_timestamp" },
    { sqliteRows: [sqlite({ created_at: TS2, updated_at: TS1 })], reason: "invalid_timestamp" },
    { sqliteRows: [sqlite({ content_md: null })], reason: "invalid_content" },
    { markdownRows: [markdown({ folder: "2025-12-30_01-05(bad)" })], reason: "invalid_week" },
  ];
  for (const item of cases) {
    const io = adapters(item);
    const manifest = await buildWeeklyFeedbackManifest({ userIds: [USER], source: io.source, target: io.target });
    assert.ok(manifest.error_count > 0);
    assert.ok(manifest.records.some((record) => record.reason === item.reason), item.reason);
  }
});

test("target identity and orphan rows are bound into the reviewed manifest", async () => {
  const io = adapters();
  let manifest = await buildWeeklyFeedbackManifest({ userIds: [USER], source: io.source, target: io.target });
  assert.deepEqual(manifest.target_identity, { database_name: "stride", server_uuid: "server-1" });
  io.target.getIdentity = async () => ({ database_name: "other", server_uuid: "server-2" });
  await assert.rejects(applyWeeklyFeedbackManifest({
    reviewedManifest: manifest, reviewedHash: manifest.manifest_hash,
    userIds: [USER], source: io.source, target: io.target,
  }), /drift/i);

  const orphan = { user_id: USER, week_start: "2025-12-29", content_md: "orphan", created_at: TS1, updated_at: TS2 };
  const orphanIO = adapters({ targetRows: [orphan] });
  manifest = await buildWeeklyFeedbackManifest({ userIds: [USER], source: orphanIO.source, target: orphanIO.target });
  assert.equal(manifest.records[0].reason, "target_without_source");
  assert.equal(manifest.error_count, 1);
});

test("matching target is idempotent while divergent target is a conflict", async () => {
  const base = { user_id: USER, week_start: "2025-12-29", content_md: " sqlite ", created_at: TS1, updated_at: TS2 };
  let io = adapters({ sqliteRows: [sqlite()], targetRows: [base] });
  let manifest = await buildWeeklyFeedbackManifest({ userIds: [USER], source: io.source, target: io.target });
  assert.equal(manifest.records[0].action, "identical");
  assert.equal(manifest.error_count, 0);

  io = adapters({ sqliteRows: [sqlite()], targetRows: [{ ...base, content_md: "different" }] });
  manifest = await buildWeeklyFeedbackManifest({ userIds: [USER], source: io.source, target: io.target });
  assert.equal(manifest.records[0].reason, "target_divergent");
  assert.equal(manifest.error_count, 1);
});

test("apply requires an unchanged zero-error reviewed manifest and verifies inside one transaction", async () => {
  const io = adapters({ sqliteRows: [sqlite()] });
  const reviewed = await buildWeeklyFeedbackManifest({ userIds: [USER], source: io.source, target: io.target });
  const result = await applyWeeklyFeedbackManifest({
    reviewedManifest: reviewed, reviewedHash: reviewed.manifest_hash,
    userIds: [USER], source: io.source, target: io.target,
  });
  assert.equal(result.records[0].action, "inserted");
  assert.equal(io.targetRows.length, 1);
  assert.equal(io.targetRows[0].content_md, " sqlite ");

  await assert.rejects(applyWeeklyFeedbackManifest({
    reviewedManifest: { ...reviewed, error_count: 1 }, reviewedHash: reviewed.manifest_hash,
    userIds: [USER], source: io.source, target: io.target,
  }), FeedbackManifestError);
});

test("apply rolls back all writes when insert or readback verification fails", async () => {
  for (const failure of ["insert", "verify"]) {
    const io = adapters({ sqliteRows: [sqlite()] });
    const reviewed = await buildWeeklyFeedbackManifest({ userIds: [USER], source: io.source, target: io.target });
    const originalTransaction = io.target.transaction;
    io.target.transaction = (operation) => originalTransaction(async (tx) => operation({
      ...tx,
      insertWeeklyFeedback: failure === "insert" ? async () => { throw new Error("insert failed"); } : tx.insertWeeklyFeedback,
      listWeeklyFeedback: failure === "verify" ? async () => [] : tx.listWeeklyFeedback,
    }));
    await assert.rejects(applyWeeklyFeedbackManifest({
      reviewedManifest: reviewed, reviewedHash: reviewed.manifest_hash,
      userIds: [USER], source: io.source, target: io.target,
    }));
    assert.deepEqual(io.targetRows, []);
  }
});

test("apply rolls back when a local source changes after the destination check", async () => {
  const rows = [sqlite()];
  const io = adapters({ sqliteRows: rows });
  const reviewed = await buildWeeklyFeedbackManifest({ userIds: [USER], source: io.source, target: io.target });
  const originalTransaction = io.target.transaction;
  io.target.transaction = (operation) => originalTransaction(async (tx) => operation({
    ...tx,
    insertWeeklyFeedback: async (row) => {
      await tx.insertWeeklyFeedback(row);
      rows[0].content_md = "changed during commit";
    },
  }));
  await assert.rejects(applyWeeklyFeedbackManifest({
    reviewedManifest: reviewed,
    reviewedHash: reviewed.manifest_hash,
    userIds: [USER],
    source: io.source,
    target: io.target,
  }), /source drift during commit/);
  assert.deepEqual(io.targetRows, []);
});

test("manifest is bound to the selected allowlisted user identities", async () => {
  const io = adapters();
  const reviewed = await buildWeeklyFeedbackManifest({ userIds: [USER], source: io.source, target: io.target });
  await assert.rejects(applyWeeklyFeedbackManifest({
    reviewedManifest: reviewed, reviewedHash: reviewed.manifest_hash,
    userIds: ["22222222-2222-4222-8222-222222222222"], source: io.source, target: io.target,
  }), /users/i);
});

test("users with no candidates remain bound into the reviewed manifest", async () => {
  const io = adapters();
  const reviewed = await buildWeeklyFeedbackManifest({ userIds: [USER], source: io.source, target: io.target });
  assert.deepEqual(reviewed.users, [USER]);
  assert.deepEqual(reviewed.records, []);
  const result = await applyWeeklyFeedbackManifest({
    reviewedManifest: reviewed, reviewedHash: reviewed.manifest_hash,
    userIds: [USER], source: io.source, target: io.target,
  });
  assert.deepEqual(result.records, []);
});

test("an invalid SQLite row still blocks Markdown fallback for its normalized week", async () => {
  const io = adapters({ sqliteRows: [sqlite({ created_at: null })], markdownRows: [markdown()] });
  const manifest = await buildWeeklyFeedbackManifest({ userIds: [USER], source: io.source, target: io.target });
  assert.equal(manifest.records.length, 1);
  assert.equal(manifest.records[0].source_kind, "sqlite");
  assert.equal(manifest.records[0].reason, "invalid_timestamp");
  assert.equal(manifest.candidates.find((candidate) => candidate.source_kind === "markdown").selected, false);
});
