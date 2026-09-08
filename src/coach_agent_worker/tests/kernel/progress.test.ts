import assert from "node:assert/strict";
import test from "node:test";
import { MonotonicProgress } from "../../src/kernel/progress.js";

test("maps each master-plan kernel node to a monotonic stage/progress anchor", () => {
  const progress = new MonotonicProgress();
  assert.deepEqual(progress.observe("initialize"), { stage: "reading_history", progressPct: 10 });
  assert.deepEqual(progress.observe("assess_goal"), { stage: "evaluating", progressPct: 28 });
  assert.deepEqual(progress.observe("expand_skeleton"), { stage: "planning_phases", progressPct: 68 });
  assert.deepEqual(progress.observe("finalize"), { stage: "outputting", progressPct: 99 });
  assert.deepEqual(progress.snapshot(), { stage: "outputting", progressPct: 99 });
});

test("never regresses even if the stream reports an earlier node out of order", () => {
  const progress = new MonotonicProgress();
  progress.observe("expand_skeleton"); // 68
  progress.observe("assess_athlete"); // 20 — ignored
  progress.observe("finalize"); // 99
  progress.observe("initialize"); // 10 — ignored
  assert.deepEqual(progress.snapshot(), { stage: "outputting", progressPct: 99 });
});

test("fan-out node keys with a Send index map to their base node", () => {
  const progress = new MonotonicProgress();
  assert.deepEqual(progress.observe("judge_worker:018b3f-abc"), { stage: "planning_phases", progressPct: 55 });
  assert.deepEqual(progress.observe("review_worker:xyz"), { stage: "outputting", progressPct: 88 });
});

test("unknown nodes are ignored", () => {
  const progress = new MonotonicProgress();
  assert.equal(progress.observe("__start__"), null);
  assert.equal(progress.observe("mystery_node"), null);
  assert.deepEqual(progress.snapshot(), { stage: "", progressPct: 0 });
});
