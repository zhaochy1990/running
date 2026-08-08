import { formatDatetimeMs } from "./masterplan-transform.js";

export const WEEKLY_PLAN_CONTENT_MARKDOWN = 1;
export const WEEKLY_PLAN_CONTENT_STRUCTURED = 2;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_FOLDER_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})(?:\([^/\\]*\))?$/;
const INTEGER_FIELDS = new Set([
  "session_index",
  "repeat",
  "hr_cap_bpm",
  "sets",
  "target_value",
  "rest_seconds",
]);
const MEASUREMENT_FIELDS = new Set([
  "total_distance_m",
  "total_duration_s",
  "value",
  "low",
  "high",
  "kcal_target",
  "kcal",
  "carbs_g",
  "protein_g",
  "fat_g",
  "water_ml",
]);
const SESSION_KINDS = new Set(["run", "strength", "rest", "cross", "note"]);
const STEP_KINDS = new Set(["warmup", "work", "recovery", "cooldown", "rest"]);
const DURATION_KINDS = new Set(["distance_m", "time_s", "open"]);
const TARGET_KINDS = new Set(["pace_s_km", "hr_bpm", "power_w", "open"]);
const STRENGTH_TARGET_KINDS = new Set(["reps", "time_s"]);

export class WeeklyPlanTransformError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "WeeklyPlanTransformError";
    this.reason = reason;
  }
}

function parseIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value, days) {
  const date = parseIsoDate(value);
  if (!date) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

export function naturalWeekBounds(weekStart) {
  const start = parseIsoDate(weekStart);
  if (!start || start.getUTCDay() !== 1) {
    throw new WeeklyPlanTransformError(
      "invalid_natural_week",
      `${weekStart ?? "missing date"} is not a valid Monday`,
    );
  }
  return { weekStart, weekEnd: addDays(weekStart, 6) };
}

export function parseWeekFolder(folder) {
  if (typeof folder !== "string") return null;
  const match = WEEK_FOLDER_RE.exec(folder);
  if (!match) return null;
  const [, year, startMonth, startDay, endMonth, endDay] = match;
  const weekStart = `${year}-${startMonth}-${startDay}`;
  const start = parseIsoDate(weekStart);
  if (!start) return null;
  const endYear = Number(endMonth) < Number(startMonth) ? Number(year) + 1 : Number(year);
  const weekEnd = `${endYear}-${endMonth}-${endDay}`;
  if (!parseIsoDate(weekEnd)) return null;
  try {
    const expected = naturalWeekBounds(weekStart);
    return expected.weekEnd === weekEnd ? expected : null;
  } catch {
    return null;
  }
}

function sourceRef(entity, fallback) {
  return String(entity?.rowKey ?? entity?.name ?? fallback);
}

/**
 * Resolve an Azure Table entity to a week before validating its content. A
 * known date_from remains the grouping key even when date_to is bad, ensuring
 * that an invalid structured record still shadows that week's Markdown.
 */
export function describeStructuredSource(entity) {
  const claims = [];
  const dateFrom = parseIsoDate(entity?.date_from) ? entity.date_from : null;
  if (dateFrom) claims.push(dateFrom);

  const rowKey = String(entity?.rowKey ?? "");
  if (parseIsoDate(rowKey)) claims.push(rowKey);
  else {
    const rowBounds = parseWeekFolder(rowKey);
    if (rowBounds) claims.push(rowBounds.weekStart);
  }

  const folderBounds = parseWeekFolder(entity?.week_folder);
  if (folderBounds) claims.push(folderBounds.weekStart);

  try {
    const plan = JSON.parse(entity?.plan_json ?? "null");
    const planBounds = parseWeekFolder(plan?.week_folder);
    if (planBounds) claims.push(planBounds.weekStart);
  } catch {
    // Invalid JSON is reported by the structured transform after precedence is fixed.
  }

  const uniqueClaims = [...new Set(claims)];
  const weekStart = dateFrom ?? (uniqueClaims.length === 1 ? uniqueClaims[0] : null);
  if (!weekStart || uniqueClaims.some((claim) => claim !== weekStart)) {
    return {
      issue: {
        reason: "source_ambiguity",
        message: weekStart
          ? `structured source ${sourceRef(entity, weekStart)} has conflicting week metadata`
          : `structured source ${sourceRef(entity, "unknown")} cannot be assigned to one week`,
      },
      blockedWeeks: uniqueClaims,
    };
  }

  let issue = null;
  try {
    const bounds = naturalWeekBounds(weekStart);
    if (entity?.date_from !== weekStart || entity?.date_to !== bounds.weekEnd) {
      issue = {
        reason: "invalid_natural_week",
        message: `structured source ${sourceRef(entity, weekStart)} is not Monday through Sunday`,
      };
    }
  } catch (error) {
    issue = { reason: error.reason, message: error.message };
  }

  return {
    source: {
      kind: "structured",
      weekStart,
      sourceRef: sourceRef(entity, weekStart),
      value: entity,
      issue,
    },
  };
}

export function describeMarkdownSource(blob) {
  const bounds = parseWeekFolder(blob?.folder);
  if (!bounds) {
    return {
      issue: {
        reason: "invalid_natural_week",
        message: `markdown source ${sourceRef(blob, "unknown")} has an invalid week folder`,
      },
    };
  }
  return {
    source: {
      kind: "markdown",
      weekStart: bounds.weekStart,
      sourceRef: sourceRef(blob, blob.folder),
      value: blob,
      issue: null,
    },
  };
}

function groupByWeek(sources) {
  const grouped = new Map();
  for (const source of sources) {
    const values = grouped.get(source.weekStart) ?? [];
    values.push(source);
    grouped.set(source.weekStart, values);
  }
  return grouped;
}

/** Select one source per week before either representation is validated. */
export function selectPlanSources(structured, markdown, { preferMarkdown = false } = {}) {
  const selected = [];
  const issues = [];
  const structuredByWeek = groupByWeek(structured);
  const markdownByWeek = groupByWeek(markdown);

  const preferred = preferMarkdown ? markdownByWeek : structuredByWeek;
  const fallback = preferMarkdown ? structuredByWeek : markdownByWeek;
  for (const [weekStart, sources] of preferred) {
    if (sources.length !== 1) {
      issues.push({
        weekStart,
        reason: "source_ambiguity",
        message: `${sources.length} structured records exist for ${weekStart}`,
      });
    } else {
      selected.push(sources[0]);
    }
  }
  for (const [weekStart, sources] of fallback) {
    if (preferred.has(weekStart)) continue;
    if (sources.length !== 1) {
      issues.push({
        weekStart,
        reason: "source_ambiguity",
        message: `${sources.length} markdown records exist for ${weekStart}`,
      });
    } else {
      selected.push(sources[0]);
    }
  }
  selected.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  return { selected, issues };
}

function cleanNode(value) {
  if (Array.isArray(value)) return value.map(cleanNode);
  if (value === null || typeof value !== "object") return value;
  const cleaned = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== "schema") cleaned[key] = cleanNode(child);
  }
  return cleaned;
}

function validateNumbers(value, path = "content") {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new WeeklyPlanTransformError("invalid_content", `${path} must be a finite number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateNumbers(child, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (child != null && INTEGER_FIELDS.has(key) && !Number.isInteger(child)) {
      throw new WeeklyPlanTransformError("invalid_content", `${path}.${key} must be an integer`);
    }
    if (
      child != null &&
      MEASUREMENT_FIELDS.has(key) &&
      (typeof child !== "number" || !Number.isFinite(child))
    ) {
      throw new WeeklyPlanTransformError(
        "invalid_content",
        `${path}.${key} must be a finite number or null`,
      );
    }
    validateNumbers(child, `${path}.${key}`);
  }
}

function requireDateInWeek(value, weekStart, weekEnd, label) {
  if (!parseIsoDate(value) || value < weekStart || value > weekEnd) {
    throw new WeeklyPlanTransformError(
      "invalid_content",
      `${label} date ${String(value)} is outside ${weekStart}..${weekEnd}`,
    );
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WeeklyPlanTransformError("invalid_content", `${label} must be an object`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WeeklyPlanTransformError("invalid_content", `${label} must be a non-empty string`);
  }
}

function requireEnum(value, allowed, label) {
  if (!allowed.has(value)) {
    throw new WeeklyPlanTransformError("invalid_content", `${label} has unsupported value ${String(value)}`);
  }
}

function pick(source, keys) {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]),
  );
}

function canonicalRunSpec(spec) {
  const result = pick(spec, ["name", "date", "note"]);
  result.blocks = spec.blocks.map((block) => ({
    ...pick(block, ["repeat"]),
    steps: block.steps.map((step) => ({
      ...pick(step, ["step_kind"]),
      duration: pick(step.duration, ["kind", "value"]),
      target: pick(step.target, ["kind", "low", "high"]),
      ...pick(step, ["note", "hr_cap_bpm"]),
    })),
  }));
  return result;
}

function canonicalStrengthSpec(spec) {
  const result = pick(spec, ["name", "date", "note"]);
  result.exercises = spec.exercises.map((exercise) => pick(exercise, [
    "canonical_id",
    "display_name",
    "sets",
    "target_kind",
    "target_value",
    "rest_seconds",
    "note",
    "provider_id",
  ]));
  return result;
}

function canonicalStructuredContent(plan) {
  const result = {
    sessions: plan.sessions.map((session) => {
      const canonical = pick(session, [
        "date",
        "session_index",
        "kind",
        "summary",
        "notes_md",
        "total_distance_m",
        "total_duration_s",
      ]);
      if (Object.hasOwn(session, "spec")) {
        canonical.spec = session.spec == null
          ? null
          : session.kind === "run"
            ? canonicalRunSpec(session.spec)
            : canonicalStrengthSpec(session.spec);
      }
      return canonical;
    }),
    nutrition: plan.nutrition.map((nutrition) => {
      const canonical = pick(nutrition, [
        "date",
        "kcal_target",
        "carbs_g",
        "protein_g",
        "fat_g",
        "water_ml",
        "notes_md",
      ]);
      if (Object.hasOwn(nutrition, "meals")) {
        canonical.meals = nutrition.meals.map((meal) => pick(meal, [
          "name",
          "time_hint",
          "kcal",
          "carbs_g",
          "protein_g",
          "fat_g",
          "items_md",
        ]));
      }
      return canonical;
    }),
  };
  if (Object.hasOwn(plan, "notes_md")) result.notes_md = plan.notes_md;
  return result;
}

function validateRunSpec(spec, label) {
  requireObject(spec, label);
  requireString(spec.name, `${label}.name`);
  if (!parseIsoDate(spec.date)) {
    throw new WeeklyPlanTransformError("invalid_content", `${label}.date must be an ISO date`);
  }
  if (!Array.isArray(spec.blocks) || spec.blocks.length === 0) {
    throw new WeeklyPlanTransformError("invalid_content", `${label}.blocks must be a non-empty array`);
  }
  spec.blocks.forEach((block, blockIndex) => {
    const blockLabel = `${label}.blocks[${blockIndex}]`;
    requireObject(block, blockLabel);
    const repeat = block.repeat ?? 1;
    if (!Number.isInteger(repeat) || repeat < 1) {
      throw new WeeklyPlanTransformError("invalid_content", `${blockLabel}.repeat must be >= 1`);
    }
    if (!Array.isArray(block.steps) || block.steps.length === 0) {
      throw new WeeklyPlanTransformError("invalid_content", `${blockLabel}.steps must be a non-empty array`);
    }
    block.steps.forEach((step, stepIndex) => {
      const stepLabel = `${blockLabel}.steps[${stepIndex}]`;
      requireObject(step, stepLabel);
      requireEnum(step.step_kind, STEP_KINDS, `${stepLabel}.step_kind`);
      requireObject(step.duration, `${stepLabel}.duration`);
      requireEnum(step.duration.kind, DURATION_KINDS, `${stepLabel}.duration.kind`);
      requireObject(step.target, `${stepLabel}.target`);
      requireEnum(step.target.kind, TARGET_KINDS, `${stepLabel}.target.kind`);
    });
  });
}

function validateStrengthSpec(spec, label) {
  requireObject(spec, label);
  requireString(spec.name, `${label}.name`);
  if (!parseIsoDate(spec.date)) {
    throw new WeeklyPlanTransformError("invalid_content", `${label}.date must be an ISO date`);
  }
  if (!Array.isArray(spec.exercises) || spec.exercises.length === 0) {
    throw new WeeklyPlanTransformError("invalid_content", `${label}.exercises must be a non-empty array`);
  }
  spec.exercises.forEach((exercise, exerciseIndex) => {
    const exerciseLabel = `${label}.exercises[${exerciseIndex}]`;
    requireObject(exercise, exerciseLabel);
    requireString(exercise.canonical_id, `${exerciseLabel}.canonical_id`);
    requireString(exercise.display_name, `${exerciseLabel}.display_name`);
    requireEnum(exercise.target_kind, STRENGTH_TARGET_KINDS, `${exerciseLabel}.target_kind`);
    if (!Number.isInteger(exercise.sets) || exercise.sets < 1) {
      throw new WeeklyPlanTransformError("invalid_content", `${exerciseLabel}.sets must be >= 1`);
    }
    if (!Number.isInteger(exercise.target_value) || exercise.target_value < 1) {
      throw new WeeklyPlanTransformError("invalid_content", `${exerciseLabel}.target_value must be >= 1`);
    }
    const restSeconds = exercise.rest_seconds ?? 60;
    if (!Number.isInteger(restSeconds) || restSeconds < 0) {
      throw new WeeklyPlanTransformError("invalid_content", `${exerciseLabel}.rest_seconds must be >= 0`);
    }
  });
}

export function cleanAndValidateStructured(plan, weekStart) {
  const { weekEnd } = naturalWeekBounds(weekStart);
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new WeeklyPlanTransformError("invalid_content", "structured content must be an object");
  }
  const cleaned = cleanNode(plan);
  delete cleaned.week_folder;
  if (!Array.isArray(cleaned.sessions) || !Array.isArray(cleaned.nutrition)) {
    throw new WeeklyPlanTransformError(
      "invalid_content",
      "structured content requires sessions and nutrition arrays",
    );
  }
  validateNumbers(cleaned);

  const identities = new Set();
  cleaned.sessions.forEach((session, index) => {
    if (session === null || typeof session !== "object" || Array.isArray(session)) {
      throw new WeeklyPlanTransformError("invalid_content", `sessions[${index}] must be an object`);
    }
    delete session.scheduled_workout_id;
    requireDateInWeek(session.date, weekStart, weekEnd, `sessions[${index}]`);
    requireEnum(session.kind, SESSION_KINDS, `sessions[${index}].kind`);
    requireString(session.summary, `sessions[${index}].summary`);
    if (!Number.isInteger(session.session_index) || session.session_index < 0) {
      throw new WeeklyPlanTransformError(
        "invalid_content",
        `sessions[${index}].session_index must be a non-negative integer`,
      );
    }
    const identity = `${session.date}/${session.session_index}`;
    if (identities.has(identity)) {
      throw new WeeklyPlanTransformError("invalid_content", `duplicate session identity ${identity}`);
    }
    identities.add(identity);
    if (session.spec != null) {
      if (session.kind === "run") validateRunSpec(session.spec, `sessions[${index}].spec`);
      else if (session.kind === "strength") validateStrengthSpec(session.spec, `sessions[${index}].spec`);
      else {
        throw new WeeklyPlanTransformError(
          "invalid_content",
          `sessions[${index}].spec must be null for kind ${session.kind}`,
        );
      }
    }
  });

  const nutritionDates = new Set();
  cleaned.nutrition.forEach((nutrition, index) => {
    if (nutrition === null || typeof nutrition !== "object" || Array.isArray(nutrition)) {
      throw new WeeklyPlanTransformError("invalid_content", `nutrition[${index}] must be an object`);
    }
    requireDateInWeek(nutrition.date, weekStart, weekEnd, `nutrition[${index}]`);
    if (nutritionDates.has(nutrition.date)) {
      throw new WeeklyPlanTransformError(
        "invalid_content",
        `duplicate nutrition date ${nutrition.date}`,
      );
    }
    nutritionDates.add(nutrition.date);
    if (nutrition.meals != null) {
      if (!Array.isArray(nutrition.meals)) {
        throw new WeeklyPlanTransformError(
          "invalid_content",
          `nutrition[${index}].meals must be an array`,
        );
      }
      nutrition.meals.forEach((meal, mealIndex) => {
        requireObject(meal, `nutrition[${index}].meals[${mealIndex}]`);
        requireString(meal.name, `nutrition[${index}].meals[${mealIndex}].name`);
      });
    }
  });
  return canonicalStructuredContent(cleaned);
}

function requiredTimestamp(value, source) {
  const formatted = formatDatetimeMs(value);
  if (!formatted) {
    throw new WeeklyPlanTransformError(
      "missing_timestamp",
      `${source} has no reliable source timestamp`,
    );
  }
  return formatted;
}

export function structuredWeeklyPlanRow(source, userId, masterPlanId = null) {
  if (source.issue) {
    throw new WeeklyPlanTransformError(source.issue.reason, source.issue.message);
  }
  const entity = source.value;
  let plan;
  try {
    plan = JSON.parse(entity.plan_json);
  } catch {
    throw new WeeklyPlanTransformError(
      "invalid_content",
      `structured source ${source.sourceRef} is not valid JSON`,
    );
  }
  const cleaned = cleanAndValidateStructured(plan, source.weekStart);
  const timestamp = requiredTimestamp(entity.updated_at, source.sourceRef);
  return {
    user_id: userId,
    master_plan_id: masterPlanId,
    week_start: source.weekStart,
    content_version: WEEKLY_PLAN_CONTENT_STRUCTURED,
    content: JSON.stringify(cleaned),
    status: "active",
    status_slot: "active",
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function markdownWeeklyPlanRow(source, userId, masterPlanId = null) {
  if (source.issue) {
    throw new WeeklyPlanTransformError(source.issue.reason, source.issue.message);
  }
  const markdown = source.value?.text;
  if (typeof markdown !== "string" || markdown.trim() === "") {
    throw new WeeklyPlanTransformError(
      "invalid_content",
      `markdown source ${source.sourceRef} is empty`,
    );
  }
  const timestamp = requiredTimestamp(source.value.lastModified, source.sourceRef);
  return {
    user_id: userId,
    master_plan_id: masterPlanId,
    week_start: source.weekStart,
    content_version: WEEKLY_PLAN_CONTENT_MARKDOWN,
    content: markdown,
    status: "active",
    status_slot: "active",
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])]),
  );
}

export function weeklyPlanContentEqual(existing, candidate) {
  if ((existing.master_plan_id ?? null) !== (candidate.master_plan_id ?? null)) return false;
  if (Number(existing.content_version) !== candidate.content_version) return false;
  if (candidate.content_version === WEEKLY_PLAN_CONTENT_MARKDOWN) {
    return existing.content === candidate.content;
  }
  try {
    return JSON.stringify(canonicalJson(JSON.parse(existing.content))) ===
      JSON.stringify(canonicalJson(JSON.parse(candidate.content)));
  } catch {
    return false;
  }
}

export function masterPlanCandidates(masterPlans, weekStart) {
  const exactCandidates = new Set();
  const dateRangeCandidates = new Set();
  for (const row of masterPlans) {
    if (Number(row.content_version) !== 2 || typeof row.content !== "string") continue;
    let plan;
    try {
      plan = JSON.parse(row.content);
    } catch {
      continue;
    }
    const weeks = [
      ...(Array.isArray(plan.weeks) ? plan.weeks : []),
      ...(Array.isArray(plan.weekly_key_sessions) ? plan.weekly_key_sessions : []),
    ];
    if (weeks.some((week) => week?.week_start === weekStart)) {
      exactCandidates.add(row.plan_id);
      continue;
    }
    // Older plans can have a partial week skeleton even though their declared
    // season window covers the weekly plan. Use it only as a fallback.
    if (
      parseIsoDate(plan.start_date) &&
      parseIsoDate(plan.end_date) &&
      weekStart >= plan.start_date &&
      weekStart <= plan.end_date
    ) {
      dateRangeCandidates.add(row.plan_id);
    }
  }
  return exactCandidates.size > 0 ? [...exactCandidates] : [...dateRangeCandidates];
}
