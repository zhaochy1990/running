// workout-materialization.js — devops#586 one-window stock migration:
//
//   1. backfill spec discriminators into stored weekly_plan content (pre-#584
//      rows lost spec.schema on write) and write the content back;
//   2. backfill spec discriminators into scheduled_workout.spec_json (push
//      pipeline legacy rows);
//   3. materialize every active structured weekly plan's sessions into the
//      workout table (source=weekly, identity weekly:<plan_id>:<date>:<idx>).
//
// Idempotent by construction: discriminator backfills skip rows already
// carrying the key; materialization inserts only identities not already active
// in the workout table, so re-running (or racing a live apply) inserts nothing.
// All writes are conditional; default mode is dry-run.

import { randomUUID } from "node:crypto";

function specDiscriminator(kind) {
  if (kind === "run") return "run-workout/v1";
  if (kind === "strength") return "strength-workout/v1";
  return null;
}

/**
 * Add the spec discriminator to one spec object when missing. Pure.
 * @returns {{spec: object, changed: boolean}}
 */
export function backfillSpecDiscriminator(kind, spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return { spec, changed: false };
  }
  const want = specDiscriminator(kind);
  if (!want || spec.schema === want) return { spec, changed: false };
  // Put the discriminator first so the stored JSON reads canonically.
  const out = { schema: want, ...spec };
  return { spec: out, changed: true };
}

/**
 * Backfill spec discriminators into one stored weekly-plan content string.
 * Pure: returns the next content (or null when nothing changed).
 */
export function backfillWeeklyPlanContent(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { content: null, sessions: 0, issue: "content is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sessions)) {
    return { content: null, sessions: 0, issue: "content has no sessions array" };
  }
  let changed = 0;
  for (const session of parsed.sessions) {
    if (!session || typeof session !== "object") continue;
    const { spec, changed: specChanged } = backfillSpecDiscriminator(
      session.kind,
      session.spec,
    );
    if (specChanged) {
      session.spec = spec;
      changed += 1;
    }
  }
  if (changed === 0) return { content: null, sessions: parsed.sessions.length };
  return {
    content: JSON.stringify(parsed),
    sessions: parsed.sessions.length,
    changed,
  };
}

/**
 * Plan the workout rows for one active structured weekly plan. Pure.
 * @returns {{rows: Array<object>, issue: string|null}}
 */
export function planWeeklyWorkoutRows(planId, weekStart, content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { rows: [], issue: "content is not valid JSON" };
  }
  const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  const rows = [];
  for (const session of sessions) {
    if (!session || typeof session !== "object") continue;
    if (typeof session.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(session.date)) {
      continue;
    }
    const spec =
      session.spec && typeof session.spec === "object" ? JSON.stringify(session.spec) : null;
    let name = typeof session.summary === "string" ? session.summary : "";
    if (spec && typeof session.spec.name === "string" && session.spec.name) {
      name = session.spec.name;
    }
    rows.push({
      user_id: null, // filled by the caller (per-user loop)
      workout_id: null, // minted at insert time
      date: session.date,
      source: "weekly",
      kind: typeof session.kind === "string" ? session.kind : "",
      name,
      summary: typeof session.summary === "string" && session.summary ? session.summary : null,
      spec_json: spec,
      total_distance_m: session.total_distance_m ?? null,
      total_duration_s: session.total_duration_s ?? null,
      estimated_dose: session.estimated_dose ?? null,
      status: "active",
      plan_id: planId,
      session_index: Number.isInteger(session.session_index) ? session.session_index : null,
    });
  }
  return { rows, issue: null };
}

/** Identity key mirroring the MySQL generated column (weekly rows). */
export function weeklyIdentityKey(planId, date, sessionIndex) {
  return `weekly:${planId}:${date}:${sessionIndex}`;
}

/**
 * Run the migration over injected adapters.
 *
 * source: { listActiveWeeklyPlans(userId), listScheduledWorkouts(userId) }
 * target: {
 *   activeWeeklyIdentities(userId) -> Set<string> of identity keys,
 *   updateWeeklyPlanContent(userId, planId, content),
 *   updateScheduledWorkoutSpec(id, specJson),
 *   insertWorkout(row),
 * }
 */
export async function migrateWorkoutMaterialization({ userIds, source, target, apply = false, uuidFactory = randomUUID }) {
  const report = {
    mode: apply ? "apply" : "dry-run",
    stats: {
      plans: 0,
      content_backfilled: 0,
      scheduled_spec_backfilled: 0,
      sessions_seen: 0,
      workouts_inserted: 0,
      already_materialized: 0,
      manual: 0,
    },
    actions: [],
    manual: [],
  };

  for (const userId of userIds) {
    const [plans, scheduled, identities] = await Promise.all([
      source.listActiveWeeklyPlans(userId),
      source.listScheduledWorkouts(userId),
      target.activeWeeklyIdentities(userId),
    ]);

    // 1+2. discriminator backfills
    for (const plan of plans) {
      report.stats.plans += 1;
      const { content, issue } = backfillWeeklyPlanContent(plan.content);
      if (issue) {
        report.manual.push({ user_id: userId, plan_id: plan.plan_id, reason: issue });
        continue;
      }
      if (content == null) continue;
      report.stats.content_backfilled += 1;
      report.actions.push({
        user_id: userId,
        action: "weekly_plan_content_backfill",
        plan_id: plan.plan_id,
      });
      if (apply) await target.updateWeeklyPlanContent(userId, plan.plan_id, content);
    }
    for (const row of scheduled) {
      const kind = row.kind === "strength" ? "strength" : "run";
      let spec;
      try {
        spec = JSON.parse(row.spec_json);
      } catch {
        report.manual.push({ user_id: userId, scheduled_workout_id: row.id, reason: "spec_json is not valid JSON" });
        continue;
      }
      const { spec: next, changed } = backfillSpecDiscriminator(kind, spec);
      if (!changed) continue;
      report.stats.scheduled_spec_backfilled += 1;
      report.actions.push({
        user_id: userId,
        action: "scheduled_workout_spec_backfill",
        scheduled_workout_id: row.id,
      });
      if (apply) await target.updateScheduledWorkoutSpec(row.id, JSON.stringify(next));
    }

    // 3. weekly materialization (insert only missing identities)
    for (const plan of plans) {
      if (plan.content_version !== 2) continue;
      const { rows, issue } = planWeeklyWorkoutRows(plan.plan_id, plan.week_start, plan.content);
      if (issue) {
        report.manual.push({ user_id: userId, plan_id: plan.plan_id, reason: issue });
        continue;
      }
      report.stats.sessions_seen += rows.length;
      for (const row of rows) {
        const identity = weeklyIdentityKey(plan.plan_id, row.date, row.session_index);
        if (identities.has(identity)) {
          report.stats.already_materialized += 1;
          continue;
        }
        if (row.session_index == null || !row.kind || !row.name) {
          report.manual.push({
            user_id: userId,
            plan_id: plan.plan_id,
            date: row.date,
            session_index: row.session_index,
            reason: "session missing kind/name/session_index",
          });
          continue;
        }
        report.stats.workouts_inserted += 1;
        report.actions.push({
          user_id: userId,
          action: "workout_insert",
          plan_id: plan.plan_id,
          date: row.date,
          session_index: row.session_index,
        });
        if (apply) {
          await target.insertWorkout({ ...row, user_id: userId, workout_id: uuidFactory() });
        }
      }
    }
  }
  return report;
}
