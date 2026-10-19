import assert from "node:assert/strict";
import { test } from "node:test";

import {
  backfillSpecDiscriminator,
  backfillWeeklyPlanContent,
  migrateWorkoutMaterialization,
  planWeeklyWorkoutRows,
  weeklyIdentityKey,
} from "../src/workout-materialization.js";

const PLAN_ID = "11111111-1111-1111-1111-111111111111";

const CONTENT_PRE_584 = JSON.stringify({
  week_name: "2026-01-19_01-25",
  sessions: [
    {
      date: "2026-01-19",
      session_index: 0,
      kind: "run",
      summary: "轻松跑",
      spec: { name: "轻松跑 5km", date: "2026-01-19", note: null, blocks: [{ repeat: 1, steps: [] }] },
      total_distance_m: 5000,
      total_duration_s: 1800,
      estimated_dose: 42.5,
    },
    { date: "2026-01-20", session_index: 0, kind: "rest", summary: "休息", spec: null },
  ],
  nutrition: [],
});

function makeSource(plans = [], scheduled = []) {
  return {
    listActiveWeeklyPlans: async () => plans,
    listScheduledWorkouts: async () => scheduled,
  };
}

function makeTarget({ identities = new Set() } = {}) {
  const calls = { content: [], scheduled: [], workouts: [] };
  return {
    calls,
    target: {
      activeWeeklyIdentities: async () => identities,
      updateWeeklyPlanContent: async (userId, planId, content) => {
        calls.content.push({ userId, planId, content });
      },
      updateScheduledWorkoutSpec: async (id, specJson) => {
        calls.scheduled.push({ id, specJson });
      },
      insertWorkout: async (row) => {
        calls.workouts.push(row);
      },
    },
  };
}

test("backfillSpecDiscriminator adds run/strength discriminator only when missing", () => {
  const run = backfillSpecDiscriminator("run", { name: "x" });
  assert.equal(run.changed, true);
  assert.equal(run.spec.schema, "run-workout/v1");

  const strength = backfillSpecDiscriminator("strength", { name: "y" });
  assert.equal(strength.spec.schema, "strength-workout/v1");

  const kept = backfillSpecDiscriminator("run", { schema: "run-workout/v1", name: "x" });
  assert.equal(kept.changed, false);

  const rest = backfillSpecDiscriminator("rest", null);
  assert.equal(rest.changed, false);
});

test("backfillWeeklyPlanContent rewrites content only when a spec lost its discriminator", () => {
  const { content, changed } = backfillWeeklyPlanContent(CONTENT_PRE_584);
  assert.equal(changed, 1);
  const reparsed = JSON.parse(content);
  assert.equal(reparsed.sessions[0].spec.schema, "run-workout/v1");
  assert.equal(reparsed.sessions[1].spec, null);

  // Idempotent: the rewritten content reports no change.
  const again = backfillWeeklyPlanContent(content);
  assert.equal(again.content, null);
});

test("planWeeklyWorkoutRows mirrors the weekly identity contract", () => {
  const { rows } = planWeeklyWorkoutRows(PLAN_ID, "2026-01-19", CONTENT_PRE_584);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => weeklyIdentityKey(PLAN_ID, r.date, r.session_index)),
    [`weekly:${PLAN_ID}:2026-01-19:0`, `weekly:${PLAN_ID}:2026-01-20:0`],
  );
  // Spec name wins over summary; rest rows carry no spec.
  assert.equal(rows[0].name, "轻松跑 5km");
  assert.equal(rows[1].spec_json, null);
  assert.equal(rows[0].estimated_dose, 42.5);
});

test("migration dry-run plans actions and writes nothing", async () => {
  const { calls, target } = makeTarget();
  const report = await migrateWorkoutMaterialization({
    userIds: ["u1"],
    source: makeSource(
      [{ plan_id: PLAN_ID, week_start: "2026-01-19", content_version: 2, content: CONTENT_PRE_584 }],
      [{ id: 7, kind: "run", spec_json: JSON.stringify({ name: "pushed" }) }],
    ),
    target,
    apply: false,
  });
  assert.equal(report.mode, "dry-run");
  assert.equal(report.stats.workouts_inserted, 2);
  assert.equal(report.stats.content_backfilled, 1);
  assert.equal(report.stats.scheduled_spec_backfilled, 1);
  assert.equal(calls.workouts.length, 0);
  assert.equal(calls.content.length, 0);
  assert.equal(calls.scheduled.length, 0);
});

test("migration apply writes rows and is idempotent on re-run", async () => {
  const store = makeTarget();
  const source = makeSource(
    [{ plan_id: PLAN_ID, week_start: "2026-01-19", content_version: 2, content: CONTENT_PRE_584 }],
    [],
  );
  let uuid = 0;
  const first = await migrateWorkoutMaterialization({
    userIds: ["u1"], source, target: store.target, apply: true,
    uuidFactory: () => `uuid-${++uuid}`,
  });
  assert.equal(first.stats.workouts_inserted, 2);
  assert.equal(store.calls.workouts[0].workout_id, "uuid-1");
  assert.equal(store.calls.workouts[0].user_id, "u1");

  // Second run over the migrated state: everything already materialized.
  const identities = new Set(
    store.calls.workouts.map((r) => weeklyIdentityKey(r.plan_id, r.date, r.session_index)),
  );
  const second = await migrateWorkoutMaterialization({
    userIds: ["u1"], source, target: makeTarget({ identities }).target, apply: true,
  });
  assert.equal(second.stats.workouts_inserted, 0);
  assert.equal(second.stats.already_materialized, 2);
});

test("migration skips manual sessions instead of inserting broken rows", async () => {
  const { calls, target } = makeTarget();
  const broken = JSON.stringify({
    sessions: [{ date: "2026-01-19", session_index: null, kind: "run", summary: "s", spec: null }],
  });
  const report = await migrateWorkoutMaterialization({
    userIds: ["u1"],
    source: makeSource([{ plan_id: PLAN_ID, week_start: "2026-01-19", content_version: 2, content: broken }]),
    target,
    apply: true,
  });
  assert.equal(report.stats.workouts_inserted, 0);
  assert.equal(report.manual.length, 1);
  assert.equal(calls.workouts.length, 0);
});
