// masterplan-transform.js — pure builders for the master-plan migration
// (src/migrate-master-plans.js). No I/O; unit-tested. Turns an Azure Table
// master-plan entity (v2 structured) or a markdown blob + goal seed (v1) into a
// `master_plan` MySQL row, and a v1 goal seed into a `race_goal` row.
//
// The athlete's overall season plan (赛季训练计划) is one logical artifact stored
// in two content formats discriminated by content_version (ADR 0024):
//   2 = structured  -> content is the MasterPlan JSON blob (verbatim), version set
//   1 = markdown    -> content is the TRAINING_PLAN.md text, version NULL
// active_flag is a storage-integrity lever only (never business logic): we only
// ever migrate the *active* plan, so every migrated row carries active_flag=1.

export class MasterPlanTransformError extends Error {}

export const MASTER_PLAN_CONTENT_MARKDOWN = 1;
export const MASTER_PLAN_CONTENT_STRUCTURED = 2;

// ── v1 markdown goal seed ────────────────────────────────────────────────────
//
// The three real users still on the legacy markdown overview have no
// training_goal.json and no race_goal anywhere, so `master_plan.goal_id NOT NULL`
// cannot be satisfied from a structured source. Per ADR 0024 (decision "B") the
// real goal is extracted from each TRAINING_PLAN.md ONCE, by hand, into this
// reviewed constant — robust and auditable for three heterogeneous Chinese
// markdown files, where a runtime parser would be fragile. Each value cites its
// source line in the user's TRAINING_PLAN.md.
//
// weekly_training_days is a migration DEFAULT (5): the plans state weekly volume
// in km, not a per-week training-day count, and this field is not consumed by
// #6 or the adjustment gate. Everything else is the athlete's real, stated goal.
export const V1_GOAL_SEED = {
  // pan — title: "# Pan 马拉松训练计划 — 2026年8月30日 Sub-3:40"; 赛季目标 B目标(bold) 3:40:00.
  // No formally named race (an unnamed 上海盛夏赛事), so race_name is null.
  "5ee229a6-cdc1-4260-84d3-71ec622126c2": {
    race_name: null,
    race_date: "2026-08-30",
    race_distance: "FM",
    target_finish_time: "3:40:00",
    weekly_training_days: 5,
  },
  // dingchentao — "**目标赛事**：2026-10-18 西安马拉松"; 赛季目标 B目标(首要) 2:47:00.
  "7bd56762-3b04-42a6-9d8b-98f595628430": {
    race_name: "西安马拉松",
    race_date: "2026-10-18",
    race_distance: "FM",
    target_finish_time: "2:47:00",
    weekly_training_days: 5,
  },
  // renzhen — "**目标赛事**：南昌马拉松 2026-11-25"; "**目标成绩**：全马 3:00:00".
  "bffa65bc-4501-41e7-a68c-96da76d5b7bc": {
    race_name: "南昌马拉松",
    race_date: "2026-11-25",
    race_distance: "FM",
    target_finish_time: "3:00:00",
    weekly_training_days: 5,
  },
};

/** Format an ISO instant as MySQL DATETIME(3) `YYYY-MM-DD HH:MM:SS.fff` (UTC), or null. */
export function formatDatetimeMs(value) {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString(); // 2026-08-02T12:34:56.789Z
  return iso.slice(0, 10) + " " + iso.slice(11, 23);
}

/**
 * Build a `master_plan` row (content_version=2) from an Azure Table
 * `stridemasterplan` entity. The plan_json is stored VERBATIM as content so the
 * Go #6 reader deserialises the identical MasterPlan. goal_id / version /
 * timestamps come from the embedded JSON (the authoritative source).
 * @param {{partitionKey:string,rowKey:string,status?:string,version?:any,plan_json?:string,created_at?:any,updated_at?:any}} entity
 */
export function structuredRowFromEntity(entity) {
  const planJson = entity.plan_json;
  if (typeof planJson !== "string" || planJson === "") {
    throw new MasterPlanTransformError(`plan_json missing for plan ${entity.rowKey}`);
  }
  let doc;
  try {
    doc = JSON.parse(planJson);
  } catch {
    throw new MasterPlanTransformError(`plan_json is not valid JSON for plan ${entity.rowKey}`);
  }
  const goalId = doc?.goal?.goal_id ?? doc?.goal_id ?? null;
  if (!goalId || typeof goalId !== "string") {
    throw new MasterPlanTransformError(`no goal_id embedded in plan ${entity.rowKey}`);
  }
  let version = null;
  if (Number.isFinite(doc?.version)) version = Number(doc.version);
  else if (entity.version != null && Number.isFinite(Number(entity.version))) version = Number(entity.version);
  if (version == null) {
    throw new MasterPlanTransformError(`structured plan ${entity.rowKey} has no version`);
  }
  return {
    plan_id: entity.rowKey,
    user_id: entity.partitionKey,
    content_version: MASTER_PLAN_CONTENT_STRUCTURED,
    content: planJson,
    goal_id: goalId,
    status: "active",
    active_flag: 1,
    version,
    created_at: formatDatetimeMs(doc?.created_at ?? entity.created_at),
    updated_at: formatDatetimeMs(doc?.updated_at ?? entity.updated_at),
  };
}

/**
 * Rebind a structured plan to the athlete's active race-goal row. The MySQL
 * column and opaque JSON must carry the same id because Go returns the JSON
 * body directly while using the column for storage-level lookups.
 */
export function rebindStructuredGoal(row, goalId) {
  if (!goalId || typeof goalId !== "string") {
    throw new MasterPlanTransformError("structured plan needs an active race_goal id");
  }
  let plan;
  try {
    plan = JSON.parse(row.content);
  } catch {
    throw new MasterPlanTransformError(`plan ${row.plan_id} content is not valid JSON`);
  }
  if (!plan || typeof plan !== "object") {
    throw new MasterPlanTransformError(`plan ${row.plan_id} content must be a JSON object`);
  }
  if (plan.goal && typeof plan.goal === "object") plan.goal.goal_id = goalId;
  else plan.goal_id = goalId;
  return { ...row, goal_id: goalId, content: JSON.stringify(plan) };
}

/**
 * Build a `master_plan` row (content_version=1) from a markdown overview. version
 * is NULL (markdown has no plan-version). created_at/updated_at come from the
 * blob's last-modified instant when available, else the run time.
 */
export function markdownRow(userId, planId, markdownText, goalId, { createdAt, updatedAt } = {}) {
  if (typeof markdownText !== "string" || markdownText === "") {
    throw new MasterPlanTransformError(`empty markdown content for ${userId}`);
  }
  if (!goalId) throw new MasterPlanTransformError(`markdown row for ${userId} needs a goal_id`);
  const ca = formatDatetimeMs(createdAt);
  const ua = formatDatetimeMs(updatedAt);
  return {
    plan_id: planId,
    user_id: userId,
    content_version: MASTER_PLAN_CONTENT_MARKDOWN,
    content: markdownText,
    goal_id: goalId,
    status: "active",
    active_flag: 1,
    version: null,
    created_at: ca,
    updated_at: ua,
  };
}

/**
 * Build a `race_goal` row from a v1 goal seed, so the markdown row's soft
 * goal_id reference resolves. The athlete supplied no availability preferences,
 * so available_time_slots is an empty JSON array and the optional prefs are null.
 */
export function raceGoalRowFromSeed(userId, goalId, seed) {
  if (!seed) throw new MasterPlanTransformError(`no goal seed for ${userId}`);
  return {
    goal_id: goalId,
    user_id: userId,
    status: "active",
    active_flag: 1,
    race_date: seed.race_date,
    race_distance: seed.race_distance,
    race_name: seed.race_name ?? null,
    target_finish_time: seed.target_finish_time ?? null,
    weekly_training_days: seed.weekly_training_days,
    available_time_slots: "[]",
    strength_willingness: null,
    race_location: null,
    race_timezone: null,
  };
}
