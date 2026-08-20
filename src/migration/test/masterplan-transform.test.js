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
  rebindStructuredGoal,
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
    plan_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    user_id: "11111111-2222-4333-8444-555555555555",
    status: "active",
    version: 3,
    goal: {
      goal_id: "99999999-8888-4777-8666-555555555555",
      target_time: "3:30:00",
    },
    start_date: "2026-05-04",
    end_date: "2026-08-30",
    total_weeks: 17,
    phases: [],
    milestones: [],
    weeks: [],
    training_principles: ["consistency"],
    generated_by: "test",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-06-01T10:20:30Z",
    ...(overrides.plan || {}),
  };
  return {
    partitionKey: "11111111-2222-4333-8444-555555555555",
    rowKey: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    status: "active",
    version: 3,
    plan_json: JSON.stringify(plan),
    ...overrides.entity,
  };
}

test("structuredRowFromEntity builds a v2 row with verbatim content", () => {
  const entity = v2Entity();
  const row = structuredRowFromEntity(entity);
  assert.equal(row.plan_id, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(row.user_id, "11111111-2222-4333-8444-555555555555");
  assert.equal(row.content_version, MASTER_PLAN_CONTENT_STRUCTURED);
  assert.equal(row.content, entity.plan_json); // verbatim, byte-for-byte
  assert.equal(row.goal_id, "99999999-8888-4777-8666-555555555555");
  assert.equal(row.status, "active");
  assert.equal(row.active_flag, 1);
  assert.equal(row.revision, 3);
  assert.equal(Object.hasOwn(row, "version"), false);
  assert.equal(row.created_at, "2026-05-01 00:00:00.000");
  assert.equal(row.updated_at, "2026-06-01 10:20:30.000");
});

test("structuredRowFromEntity requires an embedded goal object", () => {
  const goalId = "77777777-6666-4555-8444-333333333333";
  const entity = v2Entity({ plan: { goal: undefined, goal_id: goalId } });
  assert.throws(() => structuredRowFromEntity(entity), /embedded goal object/i);
});

test("rebindStructuredGoal keeps the v2 column and JSON goal_id aligned", () => {
  const row = structuredRowFromEntity(v2Entity());
  const rebound = rebindStructuredGoal(row, "77777777-6666-4555-8444-333333333333");
  assert.equal(rebound.goal_id, "77777777-6666-4555-8444-333333333333");
  assert.equal(JSON.parse(rebound.content).goal.goal_id, "77777777-6666-4555-8444-333333333333");
  assert.equal(rebound.plan_id, row.plan_id);
});

test("rebindStructuredGoal preserves source bytes when goal identity already agrees", () => {
  const entity = v2Entity();
  entity.plan_json = JSON.stringify(JSON.parse(entity.plan_json), null, 2);
  const row = structuredRowFromEntity(entity);
  assert.equal(rebindStructuredGoal(row, "99999999-8888-4777-8666-555555555555").content, entity.plan_json);
});

test("structuredRowFromEntity rejects missing/invalid plan_json", () => {
  assert.throws(() => structuredRowFromEntity({ rowKey: "p", plan_json: "" }), MasterPlanTransformError);
  assert.throws(() => structuredRowFromEntity({ rowKey: "p", plan_json: "{not json" }), MasterPlanTransformError);
});

test("structuredRowFromEntity rejects a plan with no goal_id", () => {
  const entity = v2Entity({ plan: { goal: {}, goal_id: undefined } });
  assert.throws(() => structuredRowFromEntity(entity), MasterPlanTransformError);
});

test("structuredRowFromEntity rejects missing or conflicting source version metadata", () => {
  const missing = v2Entity({ plan: { version: undefined }, entity: { version: null } });
  assert.throws(() => structuredRowFromEntity(missing), MasterPlanTransformError);
  const conflict = v2Entity({ plan: { version: 3 }, entity: { version: 4 } });
  assert.throws(() => structuredRowFromEntity(conflict), /version metadata/i);
});

test("structuredRowFromEntity binds Azure and embedded identities", () => {
  assert.throws(
    () => structuredRowFromEntity(v2Entity({ plan: { user_id: "other-user" } })),
    /user_id.*does not match/i,
  );
  assert.throws(
    () => structuredRowFromEntity(v2Entity({ plan: { plan_id: "other-plan" } })),
    /plan_id.*does not match/i,
  );
  assert.throws(
    () => structuredRowFromEntity(v2Entity({ plan: { status: "draft" } })),
    /status.*active/i,
  );
});

test("structuredRowFromEntity rejects non-UUID user or plan identities", () => {
  assert.throws(
    () => structuredRowFromEntity(v2Entity({ entity: { rowKey: "not-a-uuid" }, plan: { plan_id: "not-a-uuid" } })),
    /UUID/i,
  );
});

test("legacy structured goal slug is accepted for canonical goal rebinding", () => {
  const row = structuredRowFromEntity(v2Entity({
    plan: { goal: { goal_id: "legacy-goal-slug", target_time: "3:30:00" } },
  }));
  const canonicalGoal = "77777777-6666-4555-8444-333333333333";
  const rebound = rebindStructuredGoal(row, canonicalGoal);
  assert.equal(rebound.goal_id, canonicalGoal);
  assert.equal(JSON.parse(rebound.content).goal.goal_id, canonicalGoal);
});

test("structuredRowFromEntity rejects missing required structured fields", () => {
  for (const plan of [
    { start_date: undefined },
    { end_date: undefined },
    { total_weeks: 0 },
    { phases: undefined },
    { milestones: undefined },
    { weeks: undefined, weekly_key_sessions: undefined },
    { training_principles: undefined },
    { generated_by: "" },
  ]) {
    assert.throws(() => structuredRowFromEntity(v2Entity({ plan })), /structured/i);
  }
});

test("structuredRowFromEntity validates Go reader phase, milestone, and week fields", () => {
  const invalidPlans = [
    { phases: [{ id: "p", name: "base", start_date: "bad", end_date: "2026-06-01", weekly_distance_km_low: 10, weekly_distance_km_high: 20, key_session_types: [], milestone_ids: [] }] },
    { milestones: [{ id: "m", type: "race", date: "bad", phase_id: "p", target: "finish" }] },
    { weeks: [{ week_index: 1, week_start: "bad", phase_id: "p", target_weekly_km_low: 10, target_weekly_km_high: 20, key_sessions: [] }] },
    { training_principles: ["ok", 42] },
  ];
  for (const plan of invalidPlans) {
    assert.throws(() => structuredRowFromEntity(v2Entity({ plan })), /structured plan/i);
  }
});

// ── markdownRow (v1) ─────────────────────────────────────────────────────────

test("markdownRow builds a v1 row with NULL revision", () => {
  const row = markdownRow("11111111-2222-4333-8444-555555555555", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "# 训练总纲\n", "99999999-8888-4777-8666-555555555555", {
    createdAt: "2026-04-28T01:02:03Z",
    updatedAt: "2026-04-28T01:02:03Z",
  });
  assert.equal(row.content_version, MASTER_PLAN_CONTENT_MARKDOWN);
  assert.equal(row.content, "# 训练总纲\n");
  assert.equal(row.plan_id, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(row.goal_id, "99999999-8888-4777-8666-555555555555");
  assert.equal(row.status, "active");
  assert.equal(row.active_flag, 1);
  assert.equal(row.revision, null);
  assert.equal(Object.hasOwn(row, "version"), false);
  assert.equal(row.created_at, "2026-04-28 01:02:03.000");
});

test("markdownRow rejects empty content or missing goal_id", () => {
  assert.throws(() => markdownRow("u", "p", "", "g"), MasterPlanTransformError);
  assert.throws(() => markdownRow("u", "p", "# x", ""), MasterPlanTransformError);
});

// ── raceGoalRowFromSeed (v1) ─────────────────────────────────────────────────

test("raceGoalRowFromSeed builds an active race_goal from a seed", () => {
  const seed = V1_GOAL_SEED["7bd56762-3b04-42a6-9d8b-98f595628430"]; // dingchentao
  const row = raceGoalRowFromSeed("7bd56762-3b04-42a6-9d8b-98f595628430", "99999999-8888-4777-8666-555555555555", seed);
  assert.equal(row.goal_id, "99999999-8888-4777-8666-555555555555");
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
