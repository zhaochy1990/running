// goal-transform.js — pure, dependency-free mapping from a user's local
// training_goal.json blob to a `race_goal` MySQL row, plus the goal_id
// classification the migration needs to decide re-mint vs pass-through.
//
// Everything here is deterministic and side-effect free (no filesystem, no
// MySQL, no uuid minting, no clock) so it can be unit-tested in isolation (see
// test/goal-transform.test.js). The uuid mint and timestamp fallback are the
// caller's job (migrate-training-goals.js), which passes the resolved goal_id in.
//
// The output is designed to match the Go worker's GORM model so a migrated row
// is indistinguishable from one the Go API would write/read:
//   - race_goal : src/go/internal/storage/goal_models.go (RaceGoal)
//
// Source shape (Python blob layer, stride_server/routes/training_goal.py):
//   training_goal.json {
//     current: { goal_id, type:"race", race_date, race_distance, race_name,
//                target_finish_time, weekly_training_days, available_time_slots,
//                strength_willingness, created_at, updated_at },
//     history: [ ...archived goals... ]   // NOT migrated: the API never exposes it
//   }

import { isoToMysqlDatetime6 } from "./profile-transform.js";

/** Raised for a per-record problem; the CLI records it and keeps going. */
export class GoalTransformError extends Error {}

// Canonical RFC-4122 UUID (any version). Legacy goal_ids are human slugs like
// `s1-2026-chengdu-fm`; the current Python route mints uuid4. A goal_id that is
// already a UUID is migrated verbatim; a slug must be re-minted (and its old
// value rewritten in the master-plan snapshots) so MySQL's CHAR(36) id space is
// uniform and the goal_id is opaque.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `id` is already a canonical UUID (migrated as-is, no re-mint). */
export function isUuidGoalId(id) {
  return typeof id === "string" && UUID_RE.test(id.trim());
}

/**
 * Pull and validate the `current` (active) goal out of a training_goal.json
 * blob. `history` is intentionally ignored — the redesigned API only surfaces
 * the single active goal, so archived goals are dropped (matches the Python
 * contract and src/migration/AGENTS.md's "discard what the target never reads").
 *
 * @param {object|string} blobJson parsed object or raw JSON string
 * @returns {{ goalId: string, current: object }}
 */
export function readCurrentGoal(blobJson) {
  const data = parseObject(blobJson, "training_goal");
  const current = data.current;
  if (current == null) {
    throw new GoalTransformError("training_goal has no `current` goal");
  }
  if (typeof current !== "object" || Array.isArray(current)) {
    throw new GoalTransformError("training_goal.current must be a JSON object");
  }
  const goalId = current.goal_id;
  if (typeof goalId !== "string" || goalId.trim() === "") {
    throw new GoalTransformError("training_goal.current.goal_id is missing");
  }
  // Race-only redesign: the old `type` enum is dropped, but a non-race legacy
  // goal must not be silently coerced into a race row.
  if (current.type != null && String(current.type) !== "race") {
    throw new GoalTransformError(
      `training_goal.current.type is ${JSON.stringify(current.type)}, expected "race"`,
    );
  }
  return { goalId: goalId.trim(), current };
}

/**
 * Build a `race_goal` row from a validated `current` goal object and the final
 * resolved goal_id (a pass-through UUID or a freshly minted one — the caller
 * decides via isUuidGoalId).
 *
 * The row is the always-active snapshot: status='active', active_flag=1. Missing
 * nullable fields collapse to SQL NULL (Go *string / *int8 zero); race_location
 * and race_timezone are always NULL because the Python blob never carried them
 * (the Go generator keeps applying its Asia/Shanghai default downstream).
 * created_at/updated_at are carried from the blob when present (this is a
 * back-fill of an existing goal, so its original authoring instant is
 * preserved), else left null for the caller to stamp with the run time.
 *
 * @param {string} userId canonical app UUID
 * @param {object} current the validated `current` goal (from readCurrentGoal)
 * @param {string} resolvedGoalId the id to persist (UUID; re-minted for slugs)
 * @returns {object} a row keyed by race_goal columns
 */
export function raceGoalRowFromCurrent(userId, current, resolvedGoalId) {
  if (typeof resolvedGoalId !== "string" || resolvedGoalId.trim() === "") {
    throw new GoalTransformError("resolvedGoalId is required");
  }
  return {
    goal_id: resolvedGoalId.trim(),
    user_id: userId,
    status: "active",
    active_flag: 1,
    race_date: requiredStr(current.race_date, "race_date"),
    race_distance: requiredStr(current.race_distance, "race_distance"),
    race_name: nullableStr(current.race_name),
    target_finish_time: nullableStr(current.target_finish_time),
    weekly_training_days: intField(current.weekly_training_days),
    available_time_slots: slotsJson(current.available_time_slots),
    strength_willingness: nullableStr(current.strength_willingness),
    // Not present in the Python blob → always NULL (see column contract).
    race_location: nullableStr(current.race_location),
    race_timezone: nullableStr(current.race_timezone),
    created_at: optionalDatetime(current.created_at),
    updated_at: optionalDatetime(current.updated_at),
  };
}

function parseObject(json, kind) {
  let data;
  try {
    data = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    throw new GoalTransformError(`${kind} is not valid JSON`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new GoalTransformError(`${kind} must be a JSON object`);
  }
  return data;
}

/** Non-empty string required; anything else is a hard per-record error. */
function requiredStr(v, field) {
  if (typeof v === "string" && v.trim() !== "") return v;
  throw new GoalTransformError(`training_goal.current.${field} is required`);
}

/** String → itself; null/undefined/blank → null (SQL NULL for a Go *string). */
function nullableStr(v) {
  if (v == null) return null;
  const s = typeof v === "string" ? v : String(v);
  return s.trim() === "" ? null : s;
}

/** Integer or numeric string → int; anything else → 0 (Go int zero). */
function intField(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return 0;
}

/**
 * Serialise available_time_slots to the same JSON-array text GORM's json
 * serializer writes for a []string: an array (even empty) → its JSON (`[]`,
 * `["morning"]`); absent/null → null (SQL NULL, the Go nil-slice case). Any
 * non-array truthy value is rejected rather than silently coerced.
 */
function slotsJson(v) {
  if (v == null) return null;
  if (!Array.isArray(v)) {
    throw new GoalTransformError(
      "training_goal.current.available_time_slots must be an array",
    );
  }
  return JSON.stringify(v.map((s) => String(s)));
}

/** ISO datetime → MySQL datetime string; null/blank → null (caller stamps). */
function optionalDatetime(v) {
  if (v == null || String(v).trim() === "") return null;
  try {
    return isoToMysqlDatetime6(String(v));
  } catch (err) {
    throw new GoalTransformError(
      `training_goal.current timestamp is not ISO-8601: ${err.message}`,
    );
  }
}
