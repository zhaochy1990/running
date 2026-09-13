import assert from "node:assert/strict";
import test from "node:test";
import { MASTER_PLAN_NODES } from "../../src/kernel/master/kernel.js";
import { MonotonicProgress } from "../../src/kernel/progress.js";
import { WEEKLY_PLAN_NODES } from "../../src/kernel/weekly/kernel.js";

test("maps each master-plan kernel node to a monotonic stage/progress anchor", () => {
  const progress = new MonotonicProgress(MASTER_PLAN_NODES);
  assert.deepEqual(progress.observe("initialize"), { stage: "reading_history", progressPct: 10 });
  assert.deepEqual(progress.observe("assess_goal"), { stage: "evaluating", progressPct: 28 });
  assert.deepEqual(progress.observe("expand_skeleton"), { stage: "planning_phases", progressPct: 68 });
  assert.deepEqual(progress.observe("finalize"), { stage: "outputting", progressPct: 99 });
});

test("maps each weekly-plan kernel node to a monotonic stage/progress anchor", () => {
  const progress = new MonotonicProgress(WEEKLY_PLAN_NODES);
  assert.deepEqual(progress.observe("loadWeeklyPlanContext"), { stage: "reading_history", progressPct: 10 });
  assert.deepEqual(progress.observe("getTargetTrainingLoad"), { stage: "evaluating", progressPct: 25 });
  assert.deepEqual(progress.observe("phase_base"), { stage: "planning_phases", progressPct: 55 });
  assert.deepEqual(progress.observe("simulate_load"), { stage: "rule_filter", progressPct: 75 });
  assert.deepEqual(progress.observe("finalize"), { stage: "outputting", progressPct: 99 });
});

test("never regresses even if the stream reports an earlier node out of order", () => {
  const progress = new MonotonicProgress(MASTER_PLAN_NODES);
  assert.deepEqual(progress.observe("expand_skeleton"), { stage: "planning_phases", progressPct: 68 });
  assert.equal(progress.observe("assess_athlete"), null); // 20 < 68 → ignored
  assert.deepEqual(progress.observe("finalize"), { stage: "outputting", progressPct: 99 });
  assert.equal(progress.observe("initialize"), null); // 10 < 99 → ignored
});

test("fan-out node keys with a Send index map to their base node", () => {
  const progress = new MonotonicProgress(MASTER_PLAN_NODES);
  assert.deepEqual(progress.observe("judge_worker:018b3f-abc"), { stage: "planning_phases", progressPct: 55 });
  assert.deepEqual(progress.observe("review_worker:xyz"), { stage: "outputting", progressPct: 88 });
});

test("weekly fan-out node keys (phase_base:abc) map to their base node", () => {
  const progress = new MonotonicProgress(WEEKLY_PLAN_NODES);
  assert.deepEqual(progress.observe("phase_base:abc"), { stage: "planning_phases", progressPct: 55 });
});

test("unknown nodes are ignored", () => {
  const progress = new MonotonicProgress(MASTER_PLAN_NODES);
  assert.equal(progress.observe("__start__"), null);
  assert.equal(progress.observe("mystery_node"), null);
  assert.deepEqual(progress.observe("assess_goal"), { stage: "evaluating", progressPct: 28 });
  assert.equal(progress.observe("mystery_node"), null);
  assert.equal(progress.observe("initialize"), null); // 10 < 28 → regressive
});
