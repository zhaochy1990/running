import assert from "node:assert/strict";
import test from "node:test";

import { migrateWeeklyPlans } from "../src/weekly-plan-migration.js";

const USER_ID = "11111111-2222-4333-8444-555555555555";

function master(planId = "master-a") {
  return {
    plan_id: planId,
    content_version: 2,
    content: JSON.stringify({ weeks: [{ week_start: "2026-07-06" }] }),
  };
}

function structured(overrides = {}) {
  return {
    rowKey: "2026-07-06",
    date_from: "2026-07-06",
    date_to: "2026-07-12",
    week_folder: "2026-07-06_07-12(P1W1)",
    plan_json: JSON.stringify({
      schema: "weekly-plan/v1",
      week_folder: "2026-07-06_07-12(P1W1)",
      sessions: [{ date: "2026-07-06", session_index: 0, kind: "rest", summary: "rest" }],
      nutrition: [{ date: "2026-07-06", kcal_target: 2200 }],
    }),
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function adapters({ structuredRows = [structured()], markdownRows = [], existing = [], masters = [master()] } = {}) {
  const inserts = [];
  return {
    inserts,
    source: {
      async listStructured() { return structuredRows; },
      async listMarkdown() { return markdownRows; },
      async readMarkdown(item) { return item.downloadedText; },
    },
    target: {
      async listActiveWeeklyPlans() { return existing; },
      async listMasterPlans() { return masters; },
      async insertWeeklyPlan(row) { inserts.push(row); },
    },
  };
}

test("dry-run performs no insert and does not generate a UUID", async () => {
  const io = adapters();
  let uuidCalls = 0;
  const report = await migrateWeeklyPlans({
    userIds: [USER_ID],
    source: io.source,
    target: io.target,
    uuidFactory() { uuidCalls++; return "uuid"; },
  });
  assert.equal(report.mode, "dry-run");
  assert.equal(report.stats.planned, 1);
  assert.equal(io.inserts.length, 0);
  assert.equal(uuidCalls, 0);
});

test("apply inserts active revision 1 and generates UUID only at insertion", async () => {
  const io = adapters();
  const report = await migrateWeeklyPlans({
    userIds: [USER_ID],
    source: io.source,
    target: io.target,
    apply: true,
    uuidFactory: () => "99999999-9999-4999-8999-999999999999",
  });
  assert.equal(report.stats.inserted, 1);
  assert.equal(io.inserts[0].plan_id, "99999999-9999-4999-8999-999999999999");
  assert.equal(io.inserts[0].status, "active");
  assert.equal(io.inserts[0].status_slot, "active");
  assert.equal(io.inserts[0].revision, 1);
});

test("invalid structured source is manual and does not read fallback markdown", async () => {
  const io = adapters({
    structuredRows: [structured({ plan_json: "invalid" })],
    markdownRows: [{
      name: "users/u/logs/2026-07-06_07-12/plan.md",
      folder: "2026-07-06_07-12",
      lastModified: new Date("2026-07-02T00:00:00Z"),
      downloadedText: "# fallback",
    }],
  });
  let reads = 0;
  io.source.readMarkdown = async () => { reads++; return "# fallback"; };
  const report = await migrateWeeklyPlans({ userIds: [USER_ID], source: io.source, target: io.target });
  assert.equal(report.stats.planned, 0);
  assert.equal(report.manual[0].reason, "invalid_content");
  assert.equal(reads, 0);
});

test("markdown is selected and downloaded only when structured is absent", async () => {
  const io = adapters({
    structuredRows: [],
    markdownRows: [{
      name: "users/u/logs/2026-07-06_07-12/plan.md",
      folder: "2026-07-06_07-12",
      lastModified: new Date("2026-07-02T00:00:00Z"),
      downloadedText: "# legacy plan",
    }],
  });
  let reads = 0;
  io.source.readMarkdown = async (item) => { reads++; return item.downloadedText; };
  const report = await migrateWeeklyPlans({ userIds: [USER_ID], source: io.source, target: io.target });
  assert.equal(report.stats.planned, 1);
  assert.equal(reads, 1);
});

test("ambiguous structured metadata blocks Markdown for every claimed week", async () => {
  const io = adapters({
    structuredRows: [structured({ rowKey: "2026-07-13" })],
    markdownRows: [
      {
        name: "users/u/logs/2026-07-06_07-12/plan.md",
        folder: "2026-07-06_07-12",
        lastModified: new Date("2026-07-02T00:00:00Z"),
        downloadedText: "# week one",
      },
      {
        name: "users/u/logs/2026-07-13_07-19/plan.md",
        folder: "2026-07-13_07-19",
        lastModified: new Date("2026-07-02T00:00:00Z"),
        downloadedText: "# week two",
      },
    ],
  });
  let reads = 0;
  io.source.readMarkdown = async () => { reads++; return "# must not read"; };
  const report = await migrateWeeklyPlans({ userIds: [USER_ID], source: io.source, target: io.target });
  assert.equal(report.stats.planned, 0);
  assert.equal(report.manual[0].reason, "source_ambiguity");
  assert.equal(reads, 0);
});

test("an unassignable structured row does not block unrelated Markdown weeks", async () => {
  const io = adapters({
    structuredRows: [{ rowKey: "unknown", plan_json: "invalid" }],
    markdownRows: [{
      name: "users/u/logs/2026-07-06_07-12/plan.md",
      folder: "2026-07-06_07-12",
      lastModified: new Date("2026-07-02T00:00:00Z"),
      downloadedText: "# legacy plan",
    }],
  });
  const report = await migrateWeeklyPlans({ userIds: [USER_ID], source: io.source, target: io.target });
  assert.equal(report.stats.planned, 1);
  assert.equal(report.manual.some((item) => item.reason === "source_ambiguity"), true);
});

test("same existing content is idempotent and different content is a conflict", async () => {
  const first = adapters();
  await migrateWeeklyPlans({
    userIds: [USER_ID], source: first.source, target: first.target, apply: true,
    uuidFactory: () => "plan-id",
  });
  const inserted = first.inserts[0];

  const same = adapters({ existing: [inserted] });
  const sameReport = await migrateWeeklyPlans({
    userIds: [USER_ID], source: same.source, target: same.target, apply: true,
    uuidFactory() { throw new Error("must not mint"); },
  });
  assert.equal(sameReport.stats.existing, 1);
  assert.equal(same.inserts.length, 0);

  const conflict = adapters({ existing: [{ ...inserted, content: "{}" }] });
  const conflictReport = await migrateWeeklyPlans({
    userIds: [USER_ID], source: conflict.source, target: conflict.target, apply: true,
    uuidFactory() { throw new Error("must not mint"); },
  });
  assert.equal(conflictReport.stats.conflicts, 1);
  assert.equal(conflictReport.manual[0].reason, "conflict");
  assert.equal(conflict.inserts.length, 0);
});

test("ambiguous master-plan ownership is reported for manual handling", async () => {
  const io = adapters({ masters: [master("master-a"), master("master-b")] });
  const report = await migrateWeeklyPlans({ userIds: [USER_ID], source: io.source, target: io.target });
  assert.equal(report.stats.planned, 0);
  assert.equal(report.manual[0].reason, "master_plan_ambiguity");
});

test("missing master-plan prerequisite is manual unless the user is explicitly unowned", async () => {
  const blocked = adapters({ masters: [] });
  const blockedReport = await migrateWeeklyPlans({
    userIds: [USER_ID], source: blocked.source, target: blocked.target,
  });
  assert.equal(blockedReport.stats.planned, 0);
  assert.equal(blockedReport.manual[0].reason, "master_plan_prerequisite_missing");

  const allowed = adapters({ masters: [] });
  const allowedReport = await migrateWeeklyPlans({
    userIds: [USER_ID], source: allowed.source, target: allowed.target,
    allowUnownedUserIds: new Set([USER_ID]),
  });
  assert.equal(allowedReport.stats.planned, 1);
});

test("opaque legacy master-plan ownership is reported for manual handling", async () => {
  const io = adapters({
    masters: [{ plan_id: "legacy-master", content_version: 1, content: "# season plan" }],
  });
  const report = await migrateWeeklyPlans({ userIds: [USER_ID], source: io.source, target: io.target });
  assert.equal(report.stats.planned, 0);
  assert.equal(report.manual[0].reason, "master_plan_ownership_unknown");
});
