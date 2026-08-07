import assert from "node:assert/strict";
import test from "node:test";

import {
  WeeklyPlanTransformError,
  cleanAndValidateStructured,
  describeMarkdownSource,
  describeStructuredSource,
  markdownWeeklyPlanRow,
  masterPlanCandidates,
  selectPlanSources,
  structuredWeeklyPlanRow,
  weeklyPlanContentEqual,
} from "../src/weekly-plan-transform.js";

const USER_ID = "11111111-2222-4333-8444-555555555555";
const WEEK_START = "2026-07-06";
const WEEK_END = "2026-07-12";

function plan(overrides = {}) {
  return {
    schema: "weekly-plan/v1",
    week_folder: "2026-07-06_07-12(P2W3)",
    sessions: [
      {
        schema: "plan-session/v1",
        date: WEEK_START,
        session_index: 0,
        kind: "run",
        summary: "easy",
        total_distance_m: 8000,
        scheduled_workout_id: 42,
        spec: {
          schema: "run-workout/v1",
          name: "easy",
          date: WEEK_START,
          blocks: [
            {
              repeat: 1,
              steps: [
                {
                  schema: "step/v1",
                  step_kind: "work",
                  duration: { kind: "distance_m", value: 8000 },
                  target: { kind: "open", low: null, high: null },
                },
              ],
            },
          ],
        },
      },
    ],
    nutrition: [
      {
        schema: "plan-nutrition/v1",
        date: WEEK_END,
        kcal_target: 2400,
        meals: [{ schema: "meal/v1", name: "breakfast", kcal: 500 }],
      },
    ],
    notes_md: "week notes",
    ...overrides,
  };
}

function structuredEntity(overrides = {}) {
  return {
    partitionKey: USER_ID,
    rowKey: WEEK_START,
    kind: "plan",
    week_folder: "2026-07-06_07-12(P2W3)",
    date_from: WEEK_START,
    date_to: WEEK_END,
    plan_json: JSON.stringify(plan()),
    updated_at: "2026-07-01T12:34:56.789Z",
    ...overrides,
  };
}

test("v2 clean removes every schema, top-level week_folder, and session execution id", () => {
  const source = plan({ generated_by: "legacy", phase: "base" });
  source.sessions[0].legacy_type = "easy_run";
  source.sessions[0].spec.blocks[0].steps[0].legacy_target = "z2";
  const cleaned = cleanAndValidateStructured(source, WEEK_START);
  assert.equal(cleaned.week_folder, undefined);
  assert.equal(cleaned.generated_by, undefined);
  assert.equal(cleaned.phase, undefined);
  assert.equal(cleaned.sessions[0].scheduled_workout_id, undefined);
  assert.equal(cleaned.sessions[0].legacy_type, undefined);
  assert.equal(cleaned.sessions[0].spec.blocks[0].steps[0].legacy_target, undefined);
  assert.equal(JSON.stringify(cleaned).includes('"schema"'), false);
  assert.deepEqual(Object.keys(cleaned), ["sessions", "nutrition", "notes_md"]);
});

test("v2 validates dates, identities, nutrition uniqueness, finite numbers, and integers", () => {
  assert.throws(
    () => cleanAndValidateStructured(plan({
      sessions: [
        plan().sessions[0],
        { ...plan().sessions[0] },
      ],
    }), WEEK_START),
    /duplicate session identity/,
  );
  assert.throws(
    () => cleanAndValidateStructured(plan({
      nutrition: [plan().nutrition[0], { ...plan().nutrition[0] }],
    }), WEEK_START),
    /duplicate nutrition date/,
  );
  assert.throws(
    () => cleanAndValidateStructured(plan({
      sessions: [{ ...plan().sessions[0], date: "2026-07-13" }],
    }), WEEK_START),
    /outside/,
  );
  assert.throws(
    () => cleanAndValidateStructured(plan({
      sessions: [{ ...plan().sessions[0], session_index: 0.5 }],
    }), WEEK_START),
    /integer/,
  );
  assert.throws(
    () => cleanAndValidateStructured(plan({
      nutrition: [{ ...plan().nutrition[0], kcal_target: Infinity }],
    }), WEEK_START),
    /finite number/,
  );
  assert.throws(
    () => cleanAndValidateStructured(plan({
      sessions: [{ ...plan().sessions[0], total_distance_m: "8000" }],
    }), WEEK_START),
    /finite number or null/,
  );
  assert.throws(
    () => cleanAndValidateStructured({ sessions: [], nutrition: null }, WEEK_START),
    /requires sessions and nutrition arrays/,
  );
});

test("v2 validates canonical session and workout fields", () => {
  assert.throws(
    () => cleanAndValidateStructured(plan({
      sessions: [{ ...plan().sessions[0], kind: "long_run" }],
    }), WEEK_START),
    /unsupported value/,
  );
  assert.throws(
    () => cleanAndValidateStructured(plan({
      sessions: [{ ...plan().sessions[0], summary: undefined }],
    }), WEEK_START),
    /summary/,
  );
  assert.throws(
    () => cleanAndValidateStructured(plan({
      sessions: [{
        ...plan().sessions[0],
        spec: {
          ...plan().sessions[0].spec,
          blocks: [{ repeat: 1, steps: [{
            step_kind: "sprint",
            duration: { kind: "distance_m", value: 1000 },
            target: { kind: "open", low: null, high: null },
          }] }],
        },
      }],
    }), WEEK_START),
    /step_kind/,
  );
});

test("structured source wins before validation and invalid structured never falls back", () => {
  const structured = describeStructuredSource(structuredEntity({ plan_json: "not-json" })).source;
  const markdown = describeMarkdownSource({
    name: `${USER_ID}/logs/2026-07-06_07-12/plan.md`,
    folder: "2026-07-06_07-12",
    text: "# valid markdown",
    lastModified: new Date("2026-07-02T00:00:00Z"),
  }).source;
  const result = selectPlanSources([structured], [markdown]);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].kind, "structured");
  assert.throws(
    () => structuredWeeklyPlanRow(structured, USER_ID),
    (error) => error instanceof WeeklyPlanTransformError && error.reason === "invalid_content",
  );
});

test("source rows require natural Monday-Sunday bounds and reliable timestamps", () => {
  const invalidWeek = describeStructuredSource(structuredEntity({ date_to: "2026-07-11" })).source;
  assert.throws(
    () => structuredWeeklyPlanRow(invalidWeek, USER_ID),
    (error) => error.reason === "invalid_natural_week",
  );
  const missingTimestamp = describeMarkdownSource({
    name: "plan.md",
    folder: "2026-07-06_07-12",
    text: "# plan",
    lastModified: null,
  }).source;
  assert.throws(
    () => markdownWeeklyPlanRow(missingTimestamp, USER_ID),
    (error) => error.reason === "missing_timestamp",
  );
});

test("v1 markdown must be non-empty", () => {
  const source = describeMarkdownSource({
    name: "plan.md",
    folder: "2026-07-06_07-12",
    text: "  ",
    lastModified: new Date("2026-07-02T00:00:00Z"),
  }).source;
  assert.throws(() => markdownWeeklyPlanRow(source, USER_ID), /empty/);
});

test("same structured content is existing despite JSON key order", () => {
  const source = describeStructuredSource(structuredEntity()).source;
  const row = structuredWeeklyPlanRow(source, USER_ID);
  const parsed = JSON.parse(row.content);
  const reordered = JSON.stringify({ notes_md: parsed.notes_md, nutrition: parsed.nutrition, sessions: parsed.sessions });
  assert.equal(
    weeklyPlanContentEqual({ content_version: 2, content: reordered }, row),
    true,
  );
  assert.equal(
    weeklyPlanContentEqual({ content_version: 1, content: row.content }, row),
    false,
  );
});

test("existing content with a different master-plan owner is not idempotent", () => {
  const source = describeStructuredSource(structuredEntity()).source;
  const row = structuredWeeklyPlanRow(source, USER_ID, "master-a");
  assert.equal(
    weeklyPlanContentEqual({ ...row, master_plan_id: "master-b" }, row),
    false,
  );
});

test("master plan date window owns a week missing from a partial skeleton", () => {
  const master = {
    plan_id: "master-a",
    content_version: 2,
    content: JSON.stringify({
      start_date: "2026-05-04",
      end_date: "2026-10-18",
      weeks: [{ week_start: "2026-06-29" }],
    }),
  };
  assert.deepEqual(masterPlanCandidates([master], "2026-05-04"), ["master-a"]);
  assert.deepEqual(masterPlanCandidates([master], "2026-06-29"), ["master-a"]);
  assert.deepEqual(masterPlanCandidates([master], "2026-04-27"), []);
});
