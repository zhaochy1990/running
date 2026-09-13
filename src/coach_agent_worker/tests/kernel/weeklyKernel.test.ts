import assert from "node:assert/strict";
import test from "node:test";
import { WeeklyPlanGeneratorRequest } from "@stride/contract";
import { asPermanent } from "../../src/job/errors.js";
import { runWeeklyKernel, type WeeklyPlanGraphShim } from "../../src/kernel/weekly/kernel.js";
import { buildCompletedOutcome } from "./weeklyFixtures.js";

const runtime = { userId: "athlete-1", generationId: "plan-job-1" };
const request = WeeklyPlanGeneratorRequest.parse({ request_id: "req-1" });
const FIXED_WEEK = "2026-08-17";

function buildGraph(updates: Array<Record<string, unknown>>): WeeklyPlanGraphShim {
  return {
    async stream() {
      return (async function* () {
        for (const update of updates) yield update;
      })();
    },
  };
}

test("completed kernel run streams monotonic node progress and returns the weekly plan", async () => {
  const outcome = buildCompletedOutcome(FIXED_WEEK);
  const graph = buildGraph([
    { loadWeeklyPlanContext: { context: {}, weekly_context: {} } },
    { getTargetTrainingLoad: { target_training_load: {} } },
    { phase_base: { phase: "base" } },
    { finalize: { outcome } },
  ]);
  const hbCalls: Array<{ stage: string; pct: number }> = [];
  const { weeklyPlan, phase, generationAttempts } = await runWeeklyKernel(graph, request, runtime, async (stage, pct) => {
    hbCalls.push({ stage, pct });
  });

  assert.equal(weeklyPlan.schema, "weekly-plan/v1");
  assert.equal(weeklyPlan.week_name, "2026-08-17_08-23");
  assert.equal(phase, "base");
  assert.equal(generationAttempts, 1);
  assert.equal(hbCalls[0]?.stage, "reading_history");
  for (let i = 1; i < hbCalls.length; i++) {
    assert.ok(hbCalls[i]!.pct >= hbCalls[i - 1]!.pct, `progress regressed at ${i}: ${JSON.stringify(hbCalls)}`);
  }
  assert.equal(hbCalls[hbCalls.length - 1]?.stage, "outputting");
});

test("context snapshot failure surfaces as a retryable infra error", async () => {
  const graph = buildGraph([
    {
      loadWeeklyPlanContext: {
        outcome: {
          decision: "infrastructure_failure",
          request_id: "req-1",
          generation_id: "plan-job-1",
          reason: "context_snapshot_unavailable",
        },
      },
    },
  ]);
  await assert.rejects(
    runWeeklyKernel(graph, request, runtime, async () => {}),
    (error: unknown) => {
      assert.equal(asPermanent(error), null);
      return true;
    },
  );
});

test("quality_failure maps to a permanent stable error code", async () => {
  const graph = buildGraph([
    {
      phase_unresolvable: {
        outcome: {
          decision: "quality_failure",
          request_id: "req-1",
          generation_id: "plan-job-1",
          reason: "phase_unresolvable",
        },
      },
    },
  ]);
  await assert.rejects(
    runWeeklyKernel(graph, request, runtime, async () => {}),
    (error: unknown) => {
      const permanent = asPermanent(error);
      assert.ok(permanent, "expected a permanent error");
      assert.equal(permanent.code, "kernel_weekly_phase_unresolvable");
      return true;
    },
  );
});

test("kernel that ends without any outcome is a permanent error", async () => {
  const graph = buildGraph([{ some_unknown_node: { foo: 1 } }]);
  await assert.rejects(
    runWeeklyKernel(graph, request, runtime, async () => {}),
    (error: unknown) => {
      const permanent = asPermanent(error);
      assert.ok(permanent);
      assert.equal(permanent.code, "kernel_no_outcome");
      return true;
    },
  );
});
