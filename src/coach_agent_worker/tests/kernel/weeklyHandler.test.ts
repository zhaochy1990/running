import assert from "node:assert/strict";
import test from "node:test";
import { addDays, mondayOnOrBefore, shanghaiDay, WeeklyPlanGeneratorRequest, weekFolder } from "@stride/contract";
import { asPermanent, ERROR_CODES } from "../../src/job/errors.js";
import { createWeeklyPlanJobHandler } from "../../src/kernel/weekly/handler.js";
import type { WeeklyPlanGraphShim } from "../../src/kernel/weekly/kernel.js";
import { FakePlanJobStore } from "../job/fakes.js";
import { buildCompletedOutcome } from "./weeklyFixtures.js";

/** The handler's week guard runs against the real clock — target the current Shanghai week. */
function currentWeekStart(): string {
  return mondayOnOrBefore(shanghaiDay(new Date().toISOString()));
}

function buildGraph(updates: Array<Record<string, unknown>>): WeeklyPlanGraphShim {
  return {
    async stream() {
      return (async function* () {
        for (const update of updates) yield update;
      })();
    },
  };
}

function completedGraph(weekStart: string): WeeklyPlanGraphShim {
  return buildGraph([{ finalize: { outcome: buildCompletedOutcome(weekStart) } }]);
}

test("completed run reports the weekly content in result_json (#585, no draft insert)", async () => {
  const weekStart = currentWeekStart();
  const handler = createWeeklyPlanJobHandler({ graph: completedGraph(weekStart) });
  const job = FakePlanJobStore.fixture({
    jobType: "generate_weekly_plan",
    userId: "user-1",
    inputJson: JSON.stringify({ request_id: "req-1" }),
  });

  const result = await handler(job, async () => {});

  const parsed = JSON.parse(result.result) as Record<string, unknown>;
  assert.equal(parsed.week_name, weekFolder(weekStart));
  assert.equal(parsed.phase, "base");
  assert.equal(parsed.generation_attempts, 1);
  assert.equal(parsed.generated_by, "plan-job");
  const content = parsed.content as Record<string, unknown>;
  assert.equal(content.week_name, weekFolder(weekStart));
  assert.equal(Array.isArray(content.sessions), true);
  assert.equal(Array.isArray(content.nutrition), true);
});

test("enqueued request that fails server-side re-validation is a contract violation", async () => {
  const handler = createWeeklyPlanJobHandler({ graph: completedGraph(currentWeekStart()) });
  const job = FakePlanJobStore.fixture({ jobType: "generate_weekly_plan", inputJson: "{}" });

  await assert.rejects(
    handler(job, async () => {}),
    (error: unknown) => {
      assert.equal(asPermanent(error)?.code, ERROR_CODES.CONTRACT_VIOLATION);
      return true;
    },
  );
});

test("a week outside the current/next Shanghai week is rejected", async () => {
  const staleWeek = addDays(currentWeekStart(), 21);
  const handler = createWeeklyPlanJobHandler({ graph: completedGraph(staleWeek) });
  const job = FakePlanJobStore.fixture({
    jobType: "generate_weekly_plan",
    inputJson: JSON.stringify({ request_id: "req-1" }),
  });

  await assert.rejects(
    handler(job, async () => {}),
    (error: unknown) => {
      assert.equal(asPermanent(error)?.code, ERROR_CODES.WEEK_NOT_SUPPORTED);
      return true;
    },
  );
});

test("a valid request parses (fixture sanity)", () => {
  const parsed = WeeklyPlanGeneratorRequest.parse({ request_id: "req-1", requested_as_of: "2026-09-01T00:00:00+08:00" });
  assert.equal(parsed.request_id, "req-1");
});
