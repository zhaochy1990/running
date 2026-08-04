import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MASTER_PLAN_CONTENT_MARKDOWN,
  MASTER_PLAN_CONTENT_STRUCTURED,
  MasterPlanTransformError,
  V1_GOAL_SEED,
  formatDatetimeMs,
  markdownRow,
  raceGoalRowFromSeed,
  structuredRowFromEntity,
} from "../src/masterplan-transform.js";

// ── formatDatetimeMs ─────────────────────────────────────────────────────────

test("formatDatetimeMs formats ISO instants to MySQL DATETIME(3) UTC", () => {
  assert.equal(formatDatetimeMs("2026-08-02T12:34:56.789012+00:00"), "2026-08-02 12:34:56.789");
  assert.equal(formatDatetimeMs("2026-08-02T12:34:56Z"), "2026-08-02 12:34:56.000");
  assert.equal(formatDatetimeMs(new Date("2026-01-01T00:00:00Z")), "2026-01-01 00:00:00.000");
});

test("formatDatetimeMs returns null for empty/invalid", () => {
  assert.equal(formatDatetimeMs(null), null);
  assert.equal(formatDatetimeMs(""), null);
  assert.equal(formatDatetimeMs("not-a-date"), null);
});

// ── structuredRowFromEntity (v2) ─────────────────────────────────────────────

function v2Entity(overrides = {}) {
  const plan = {
    plan_id: "p-uuid",
    status: "active",
    version: 3,
    goal: { goal_id: "g-uuid" },
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-06-01T10:20:30Z",
    ...(overrides.plan || {}),
  };
  return {
    partitionKey: "u-uuid",
    rowKey: "p-uuid",
    status: "active",
    version: 3,
    plan_json: JSON.stringify(plan),
    ...overrides.entity,
  };
}

test("structuredRowFromEntity builds a v2 row with verbatim content", () => {
  const entity = v2Entity();
  const row = structuredRowFromEntity(entity);
  assert.equal(row.plan_id, "p-uuid");
  assert.equal(row.user_id, "u-uuid");
  assert.equal(row.content_version, MASTER_PLAN_CONTENT_STRUCTURED);
  assert.equal(row.content, entity.plan_json); // verbatim, byte-for-byte
  assert.equal(row.goal_id, "g-uuid");
  assert.equal(row.status, "active");
  assert.equal(row.active_flag, 1);
  assert.equal(row.version, 3);
  assert.equal(row.created_at, "2026-05-01 00:00:00.000");
  assert.equal(row.updated_at, "2026-06-01 10:20:30.000");
});

test("structuredRowFromEntity falls back to a top-level goal_id", () => {
  const entity = v2Entity({ plan: { goal: undefined, goal_id: "legacy-slug" } });
  const row = structuredRowFromEntity(entity);
  assert.equal(row.goal_id, "legacy-slug");
});

test("structuredRowFromEntity rejects missing/invalid plan_json", () => {
  assert.throws(() => structuredRowFromEntity({ rowKey: "p", plan_json: "" }), MasterPlanTransformError);
  assert.throws(() => structuredRowFromEntity({ rowKey: "p", plan_json: "{not json" }), MasterPlanTransformError);
});

test("structuredRowFromEntity rejects a plan with no goal_id", () => {
  const entity = v2Entity({ plan: { goal: {}, goal_id: undefined } });
  assert.throws(() => structuredRowFromEntity(entity), MasterPlanTransformError);
});

test("structuredRowFromEntity rejects a structured plan with no version", () => {
  const entity = v2Entity({ plan: { version: undefined }, entity: { version: null } });
  assert.throws(() => structuredRowFromEntity(entity), MasterPlanTransformError);
});

// ── markdownRow (v1) ─────────────────────────────────────────────────────────

test("markdownRow builds a v1 row with NULL version", () => {
  const row = markdownRow("u-uuid", "mp-uuid", "# 训练总纲\n", "g-uuid", {
    createdAt: "2026-04-28T01:02:03Z",
    updatedAt: "2026-04-28T01:02:03Z",
  });
  assert.equal(row.content_version, MASTER_PLAN_CONTENT_MARKDOWN);
  assert.equal(row.content, "# 训练总纲\n");
  assert.equal(row.plan_id, "mp-uuid");
  assert.equal(row.goal_id, "g-uuid");
  assert.equal(row.status, "active");
  assert.equal(row.active_flag, 1);
  assert.equal(row.version, null);
  assert.equal(row.created_at, "2026-04-28 01:02:03.000");
});

test("markdownRow rejects empty content or missing goal_id", () => {
  assert.throws(() => markdownRow("u", "p", "", "g"), MasterPlanTransformError);
  assert.throws(() => markdownRow("u", "p", "# x", ""), MasterPlanTransformError);
});

// ── raceGoalRowFromSeed (v1) ─────────────────────────────────────────────────

test("raceGoalRowFromSeed builds an active race_goal from a seed", () => {
  const seed = V1_GOAL_SEED["7bd56762-3b04-42a6-9d8b-98f595628430"]; // dingchentao
  const row = raceGoalRowFromSeed("7bd56762-3b04-42a6-9d8b-98f595628430", "g-uuid", seed);
  assert.equal(row.goal_id, "g-uuid");
  assert.equal(row.status, "active");
  assert.equal(row.active_flag, 1);
  assert.equal(row.race_distance, "FM");
  assert.equal(row.race_name, "西安马拉松");
  assert.equal(row.target_finish_time, "2:47:00");
  assert.equal(row.available_time_slots, "[]");
  assert.equal(row.strength_willingness, null);
});

// ── V1_GOAL_SEED sanity ──────────────────────────────────────────────────────

test("V1_GOAL_SEED has 3 markdown users, all with valid FM goals", () => {
  const uids = Object.keys(V1_GOAL_SEED);
  assert.equal(uids.length, 3);
  for (const uid of uids) {
    const s = V1_GOAL_SEED[uid];
    assert.equal(s.race_distance, "FM");
    assert.match(s.race_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(s.target_finish_time, /^\d:\d{2}:\d{2}$/);
    assert.ok(Number.isInteger(s.weekly_training_days));
  }
});
