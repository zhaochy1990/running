#!/usr/bin/env node

// migrate-workout-materialization.js — devops#586 stock migration CLI.
//
// One window, three steps over the real users of src/users.js:
//   1. weekly_plan content spec-discriminator backfill (pre-#584 rows)
//   2. scheduled_workout.spec_json discriminator backfill
//   3. weekly stock materialization into the workout table
//
// Dry-run by default; --commit performs the conditional writes. Idempotent:
// re-running after --commit reports zero changes. Rehearse on the local
// docker MySQL (3308) before production, and confirm with the operator
// before touching prod (devops#527 convention).

import { parseArgs } from "node:util";

import { connect, parseMysqlConfig } from "./mysql.js";
import { users as REAL_USERS } from "./users.js";
import { migrateWorkoutMaterialization } from "./workout-materialization.js";

/** Parse CLI arguments without performing I/O (unit-testable). */
export function parseWorkoutMaterializationCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      commit: { type: "boolean", default: false },
      user: { type: "string", multiple: true, default: [] },
      limit: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const limit = values.limit == null ? Infinity : Number(values.limit);
  if (limit !== Infinity && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  const requested = values.user.flatMap((v) => v.split(",")).map((v) => v.trim().toLowerCase()).filter(Boolean);
  return { commit: values.commit, requested, limit };
}

function selectUserIds(requested, limit) {
  const pool = requested.length > 0 ? requested : REAL_USERS;
  const known = new Set(REAL_USERS);
  const unknown = requested.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`--user values must be real users from src/users.js: unknown ${unknown.join(", ")}`);
  }
  return pool.slice(0, limit === Infinity ? pool.length : limit);
}

/** MySQL adapters for migrateWorkoutMaterialization. */
export function createMySqlAdapters(conn) {
  return {
    source: {
      listActiveWeeklyPlans: async (userId) => {
        const [rows] = await conn.execute(
          `SELECT plan_id, DATE_FORMAT(week_start, '%Y-%m-%d') AS week_start,
                  content_version, content
             FROM weekly_plan WHERE user_id = ? AND status = 'active'`,
          [userId],
        );
        return rows;
      },
      listScheduledWorkouts: async (userId) => {
        const [rows] = await conn.execute(
          `SELECT id, kind, spec_json FROM scheduled_workout WHERE user_id = ?`,
          [userId],
        );
        return rows;
      },
    },
    target: {
      activeWeeklyIdentities: async (userId) => {
        const [rows] = await conn.execute(
          `SELECT CONCAT_WS(':', 'weekly', plan_id, DATE_FORMAT(date, '%Y-%m-%d'), session_index) AS identity
             FROM workout WHERE user_id = ? AND source = 'weekly' AND status = 'active'`,
          [userId],
        );
        return new Set(rows.map((r) => r.identity));
      },
      updateWeeklyPlanContent: async (userId, planId, content) => {
        await conn.execute(
          `UPDATE weekly_plan SET content = ? WHERE user_id = ? AND plan_id = ? AND status = 'active'`,
          [content, userId, planId],
        );
      },
      updateScheduledWorkoutSpec: async (id, specJson) => {
        await conn.execute(`UPDATE scheduled_workout SET spec_json = ? WHERE id = ?`, [specJson, id]);
      },
      insertWorkout: async (row) => {
        await conn.execute(
          `INSERT INTO workout
             (workout_id, user_id, date, source, kind, name, summary, spec_json,
              total_distance_m, total_duration_s, estimated_dose, status,
              plan_id, session_index, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
          [
            row.workout_id, row.user_id, row.date, row.source, row.kind, row.name,
            row.summary, row.spec_json, row.total_distance_m, row.total_duration_s,
            row.estimated_dose, row.status, row.plan_id, row.session_index,
          ],
        );
      },
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const cli = parseWorkoutMaterializationCli(argv);
  if (cli.help) {
    console.log("usage: node migrate-workout-materialization.js [--commit] [--user=<uuid>]... [--limit=N]");
    return 0;
  }
  const userIds = selectUserIds(cli.requested, cli.limit);
  const conn = await connect(parseMysqlConfig(process.env));
  try {
    const { source, target } = createMySqlAdapters(conn);
    const report = await migrateWorkoutMaterialization({
      userIds,
      source,
      target,
      apply: cli.commit,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!cli.commit && (report.stats.workouts_inserted > 0 || report.stats.content_backfilled > 0 || report.stats.scheduled_spec_backfilled > 0)) {
      console.error("\ndry-run: re-run with --commit to apply. Review the actions above first.");
    }
    return 0;
  } finally {
    await conn.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
