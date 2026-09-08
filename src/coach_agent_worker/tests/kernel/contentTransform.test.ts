import assert from "node:assert/strict";
import test from "node:test";
import { MasterPlanSchema } from "@stride/coach-agent";
import { createTestMasterPlan } from "@stride/coach-agent/test-fixtures";
import { masterPlanToDraftContent } from "../../src/kernel/contentTransform.js";

const GOAL_ID = "11111111-2222-3333-4444-555555555555";

interface Phase {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  weekly_distance_km_low: number;
  weekly_distance_km_high: number;
  key_session_types: string[];
  milestone_ids: string[];
}
interface Milestone {
  id: string;
  type: string;
  date: string;
  phase_id: string;
  target: string;
}
interface Week {
  week_index: number;
  week_start: string;
  phase_id: string;
  target_weekly_km_low: number | null;
  target_weekly_km_high: number | null;
  key_sessions: unknown[];
}
interface Content {
  goal: { goal_id: string; target_time: string };
  start_date: string;
  end_date: string;
  total_weeks: number;
  phases: Phase[];
  milestones: Milestone[];
  weeks: Week[];
  training_principles: string[];
  generated_by: string;
}

const EXACT_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Mirrors Go's validPhase / validMilestone / validWeek checks (master_plan.go). */
function assertGoContentValid(content: Content): void {
  assert.match(content.goal.goal_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(content.goal.target_time != null);
  assert.ok(content.start_date.length > 0 && content.end_date.length > 0 && content.total_weeks >= 1);
  assert.ok(Array.isArray(content.phases) && Array.isArray(content.milestones) && Array.isArray(content.weeks));
  assert.ok(content.training_principles.length > 0 && content.generated_by.length > 0);

  for (const phase of content.phases) {
    assert.ok(phase.id.trim().length > 0 && phase.name.trim().length > 0);
    assert.match(phase.start_date, EXACT_DATE);
    assert.match(phase.end_date, EXACT_DATE);
    assert.ok(typeof phase.weekly_distance_km_low === "number" && typeof phase.weekly_distance_km_high === "number");
    assert.ok(Array.isArray(phase.key_session_types) && phase.key_session_types.every((s) => typeof s === "string"));
    assert.ok(Array.isArray(phase.milestone_ids) && phase.milestone_ids.every((s) => typeof s === "string"));
  }

  for (const milestone of content.milestones) {
    assert.ok(milestone.id.trim().length > 0 && milestone.type.trim().length > 0);
    assert.ok(milestone.phase_id.trim().length > 0);
    assert.ok(milestone.target != null);
    assert.match(milestone.date, EXACT_DATE);
  }

  for (const week of content.weeks) {
    assert.ok(Number.isInteger(week.week_index) && week.week_index > 0);
    assert.match(week.week_start, EXACT_DATE);
    assert.ok(week.phase_id.trim().length > 0);
    assert.ok(Array.isArray(week.key_sessions));
  }
}

test("master plan output is adapted to the Go stored content contract", () => {
  const plan = MasterPlanSchema.parse(createTestMasterPlan());
  const content = masterPlanToDraftContent(plan, GOAL_ID) as unknown as Content;
  assertGoContentValid(content);
  assert.equal(content.goal.goal_id, GOAL_ID);
  assert.equal(
    content.milestones.length,
    plan.phases.reduce((sum, phase) => sum + phase.milestones.length, 0),
  );
});

test("transform is deterministic for at-least-once re-runs", () => {
  const plan = MasterPlanSchema.parse(createTestMasterPlan());
  const first = JSON.stringify(masterPlanToDraftContent(plan, GOAL_ID));
  const second = JSON.stringify(masterPlanToDraftContent(plan, GOAL_ID));
  assert.equal(first, second);
  // Phase ids are structural (not random UUIDs), so redelivery writes identical content.
  const content = masterPlanToDraftContent(plan, GOAL_ID) as unknown as Content;
  assert.ok(content.phases[0]?.id.startsWith("phase-"));
});

test("weeks are linked to phases by name via the generated phase ids", () => {
  const plan = MasterPlanSchema.parse(createTestMasterPlan());
  const content = masterPlanToDraftContent(plan, GOAL_ID) as unknown as Content;
  const phaseById = new Map(content.phases.map((phase) => [phase.id, phase.name]));
  for (const week of content.weeks) {
    assert.ok(phaseById.has(week.phase_id), `week references unknown phase id ${week.phase_id}`);
  }
  for (const milestone of content.milestones) {
    assert.ok(phaseById.has(milestone.phase_id), `milestone references unknown phase id ${milestone.phase_id}`);
  }
});
