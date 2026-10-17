import assert from "node:assert/strict";
import test from "node:test";
import { WeeklyPlanSchema } from "@stride/contract";
import { weeklyPlanToContent } from "../../src/kernel/weekly/contentTransform.js";
import { buildWeeklyPlan } from "./weeklyFixtures.js";

test("weeklyPlanToContent round-trips the canonical weekly-plan/v1 doc", () => {
  const content = weeklyPlanToContent(buildWeeklyPlan("2026-08-17"));
  assert.equal(WeeklyPlanSchema.safeParse(content).success, true);
  assert.equal(content.week_name, "2026-08-17_08-23");
});

test("weeklyPlanToContent is deterministic", () => {
  const plan = buildWeeklyPlan("2026-08-17");
  const first = JSON.stringify(weeklyPlanToContent(plan));
  const second = JSON.stringify(weeklyPlanToContent(plan));
  assert.equal(first, second);
});
