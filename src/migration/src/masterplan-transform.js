// masterplan-transform.js — pure builders for the master-plan migration
// (src/migrate-master-plans.js). No I/O; unit-tested. Turns an Azure Table
// master-plan entity (v2 structured) or a markdown blob + goal seed (v1) into a
// `master_plan` MySQL row, and a v1 goal seed into a `race_goal` row.
//
// The athlete's overall season plan (赛季训练计划) is one logical artifact stored
// in two content formats discriminated by content_version (ADR 0024):
//   2 = structured  -> content is the MasterPlan JSON blob, revision set
//   1 = markdown    -> content is the TRAINING_PLAN.md text, revision NULL
// active_flag is a storage-integrity lever only (never business logic): we only
// ever migrate the *active* plan, so every migrated row carries active_flag=1.

export class MasterPlanTransformError extends Error {}

export const MASTER_PLAN_CONTENT_MARKDOWN = 1;
export const MASTER_PLAN_CONTENT_STRUCTURED = 2;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value, field, planId) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new MasterPlanTransformError(`${field} must be a UUID for plan ${planId}`);
  }
}

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
 * Go reader deserialises the identical MasterPlan. The Azure partition/row keys
 * and embedded user/plan identity must agree. Legacy source version maps to the
 * canonical MySQL revision without mutating Azure.
 * @param {{partitionKey:string,rowKey:string,status?:string,version?:any,plan_json?:string,created_at?:any,updated_at?:any}} entity
 */
function isExactDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateGoReadableStructuredPlan(doc, planId) {
  if (!isExactDate(doc.start_date) || !isExactDate(doc.end_date) || doc.end_date < doc.start_date) {
    throw new MasterPlanTransformError(`structured plan ${planId} dates are invalid`);
  }
  for (const phase of doc.phases) {
    if (
      !phase || typeof phase !== "object" || Array.isArray(phase) ||
      typeof phase.id !== "string" || phase.id.trim() === "" ||
      typeof phase.name !== "string" || phase.name.trim() === "" ||
      !isExactDate(phase.start_date) || !isExactDate(phase.end_date) || phase.end_date < phase.start_date ||
      !isFiniteNumber(phase.weekly_distance_km_low) || !isFiniteNumber(phase.weekly_distance_km_high) ||
      !isStringArray(phase.key_session_types) || !isStringArray(phase.milestone_ids)
    ) {
      throw new MasterPlanTransformError(`structured plan ${planId} phase is invalid`);
    }
  }
  for (const milestone of doc.milestones) {
    if (
      !milestone || typeof milestone !== "object" || Array.isArray(milestone) ||
      typeof milestone.id !== "string" || milestone.id.trim() === "" ||
      typeof milestone.type !== "string" || milestone.type.trim() === "" ||
      typeof milestone.phase_id !== "string" || milestone.phase_id.trim() === "" ||
      milestone.target == null || !isExactDate(milestone.date)
    ) {
      throw new MasterPlanTransformError(`structured plan ${planId} milestone is invalid`);
    }
  }
  const weeks = doc.weeks ?? doc.weekly_key_sessions;
  if (!Array.isArray(weeks)) {
    throw new MasterPlanTransformError(`structured plan ${planId} weeks are required`);
  }
  for (const week of weeks) {
    if (
      !week || typeof week !== "object" || Array.isArray(week) ||
      !Number.isInteger(week.week_index) || week.week_index < 1 ||
      !isExactDate(week.week_start) ||
      typeof week.phase_id !== "string" || week.phase_id.trim() === "" ||
      (week.target_weekly_km_low != null && !isFiniteNumber(week.target_weekly_km_low)) ||
      (week.target_weekly_km_high != null && !isFiniteNumber(week.target_weekly_km_high)) ||
      !Array.isArray(week.key_sessions) || week.key_sessions.some((item) => !item || typeof item !== "object" || Array.isArray(item))
    ) {
      throw new MasterPlanTransformError(`structured plan ${planId} week is invalid`);
    }
  }
  if (!isStringArray(doc.training_principles)) {
    throw new MasterPlanTransformError(`structured plan ${planId} training_principles are invalid`);
  }
}

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
  if (doc?.user_id !== entity.partitionKey) {
    throw new MasterPlanTransformError(
      `embedded user_id does not match Azure partition for plan ${entity.rowKey}`,
    );
  }
  if (doc?.plan_id !== entity.rowKey) {
    throw new MasterPlanTransformError(
      `embedded plan_id does not match Azure row key for plan ${entity.rowKey}`,
    );
  }
  if (entity.status !== "active" || doc?.status !== "active") {
    throw new MasterPlanTransformError(
      `structured plan ${entity.rowKey} status must be active in Azure and JSON`,
    );
  }
  requireUuid(entity.partitionKey, "user_id", entity.rowKey);
  requireUuid(entity.rowKey, "plan_id", entity.rowKey);
  if (!doc?.goal || typeof doc.goal !== "object" || Array.isArray(doc.goal)) {
    throw new MasterPlanTransformError(`structured plan ${entity.rowKey} needs an embedded goal object`);
  }
  const goalId = doc.goal.goal_id;
  if (!goalId || typeof goalId !== "string") {
    throw new MasterPlanTransformError(`no goal_id embedded in plan ${entity.rowKey}`);
  }
  if (typeof doc.goal.target_time !== "string") {
    throw new MasterPlanTransformError(`structured plan ${entity.rowKey} needs goal.target_time`);
  }
  const requiredStructuredFields = [
    ["start_date", typeof doc.start_date === "string" && doc.start_date !== ""],
    ["end_date", typeof doc.end_date === "string" && doc.end_date !== ""],
    ["total_weeks", Number.isInteger(doc.total_weeks) && doc.total_weeks > 0],
    ["phases", Array.isArray(doc.phases)],
    ["milestones", Array.isArray(doc.milestones)],
    ["training_principles", Array.isArray(doc.training_principles)],
    ["generated_by", typeof doc.generated_by === "string" && doc.generated_by !== ""],
  ];
  const missingField = requiredStructuredFields.find(([, valid]) => !valid)?.[0];
  if (missingField) {
    throw new MasterPlanTransformError(
      `required structured field ${missingField} is missing or invalid for plan ${entity.rowKey}`,
    );
  }
  validateGoReadableStructuredPlan(doc, entity.rowKey);
  const documentVersion = Number(doc?.version);
  const entityVersion = Number(entity.version);
  if (
    !Number.isInteger(documentVersion) || documentVersion < 1 ||
    !Number.isInteger(entityVersion) || entityVersion < 1
  ) {
    throw new MasterPlanTransformError(
      `structured plan ${entity.rowKey} needs positive integer version metadata`,
    );
  }
  if (documentVersion !== entityVersion) {
    throw new MasterPlanTransformError(
      `structured plan ${entity.rowKey} version metadata does not agree`,
    );
  }
  const version = documentVersion;
  const createdAt = formatDatetimeMs(doc?.created_at ?? entity.created_at);
  const updatedAt = formatDatetimeMs(doc?.updated_at ?? entity.updated_at);
  if (!createdAt || !updatedAt) {
    throw new MasterPlanTransformError(
      `structured plan ${entity.rowKey} needs valid created_at and updated_at`,
    );
  }
  return {
    plan_id: entity.rowKey,
    user_id: entity.partitionKey,
    content_version: MASTER_PLAN_CONTENT_STRUCTURED,
    content: planJson,
    goal_id: goalId,
    status: "active",
    active_flag: 1,
    revision: version,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/**
 * Rebind a structured plan to the athlete's active race-goal row. The MySQL
 * column and opaque JSON must carry the same id because Go returns the JSON
 * body directly while using the column for storage-level lookups.
 */
export function rebindStructuredGoal(row, goalId) {
  if (!goalId || typeof goalId !== "string" || !UUID_RE.test(goalId)) {
    throw new MasterPlanTransformError("structured plan needs an active race_goal UUID");
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
  if (!plan.goal || typeof plan.goal !== "object" || Array.isArray(plan.goal)) {
    throw new MasterPlanTransformError(`plan ${row.plan_id} needs an embedded goal object`);
  }
  const embeddedGoalId = plan.goal.goal_id;
  if (embeddedGoalId === goalId && row.goal_id === goalId) return row;
  plan.goal.goal_id = goalId;
  return { ...row, goal_id: goalId, content: JSON.stringify(plan) };
}

/**
 * Build a `master_plan` row (content_version=1) from a markdown overview.
 * revision is NULL (markdown has no plan revision). created_at/updated_at come from the
 * blob's last-modified instant when available, else the run time.
 */
export function markdownRow(userId, planId, markdownText, goalId, { createdAt, updatedAt } = {}) {
  if (typeof markdownText !== "string" || markdownText === "") {
    throw new MasterPlanTransformError(`empty markdown content for ${userId}`);
  }
  requireUuid(userId, "user_id", planId);
  requireUuid(planId, "plan_id", planId);
  requireUuid(goalId, "goal_id", planId);
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
    revision: null,
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
