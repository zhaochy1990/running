import assert from "node:assert/strict";
import test from "node:test";
import { addDays, mondayOnOrBefore, shanghaiDay, WeeklyPlanGeneratorRequest, weekFolder } from "@stride/contract";
import { asPermanent, ERROR_CODES, newPermanentError } from "../../src/job/errors.js";
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

test("completed run inserts a draft for the target week and returns its id", async () => {
  const weekStart = currentWeekStart();
  const inserts: Array<{ userId: string; weekName: string; draftId: string; content: Record<string, unknown> }> = [];
  const handler = createWeeklyPlanJobHandler({
    graph: completedGraph(weekStart),
    insertDraft: async (userId, weekName, draftId, content) => {
      inserts.push({ userId, weekName, draftId, content: content as Record<string, unknown> });
      return "draft-1";
    },
  });
  const job = FakePlanJobStore.fixture({
    jobType: "generate_weekly_plan",
    userId: "user-1",
    inputJson: JSON.stringify({ request_id: "req-1" }),
  });

  const result = await handler(job, async () => {});

  const parsed = JSON.parse(result.result) as Record<string, unknown>;
  assert.equal(result.draftId, "draft-1");
  assert.equal(parsed.draft_id, "draft-1");
  assert.equal(parsed.week_name, weekFolder(weekStart));
  assert.equal(parsed.phase, "base");
  assert.equal(parsed.generation_attempts, 1);
  assert.equal(parsed.generated_by, "plan-job");
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0]?.userId, "user-1");
  assert.equal(inserts[0]?.weekName, weekFolder(weekStart));
  assert.match(inserts[0]!.draftId, /^[0-9a-f-]{36}$/);
  assert.equal(inserts[0]?.content.week_name, weekFolder(weekStart));
});

test("enqueued request that fails server-side re-validation is a contract violation", async () => {
  const handler = createWeeklyPlanJobHandler({
    graph: completedGraph(currentWeekStart()),
    insertDraft: async () => "draft-1",
  });
  const job = FakePlanJobStore.fixture({ jobType: "generate_weekly_plan", inputJson: "{}" });

  await assert.rejects(
    handler(job, async () => {}),
    (error: unknown) => {
      assert.equal(asPermanent(error)?.code, ERROR_CODES.CONTRACT_VIOLATION);
      return true;
    },
  );
});

test("draft insert rejection propagates as a permanent error", async () => {
  const handler = createWeeklyPlanJobHandler({
    graph: completedGraph(currentWeekStart()),
    insertDraft: async () => {
      throw newPermanentError(ERROR_CODES.DRAFT_REJECTED, new Error("go rejected content"));
    },
  });
  const job = FakePlanJobStore.fixture({
    jobType: "generate_weekly_plan",
    inputJson: JSON.stringify({ request_id: "req-1" }),
  });

  await assert.rejects(
    handler(job, async () => {}),
    (error: unknown) => {
      assert.equal(asPermanent(error)?.code, ERROR_CODES.DRAFT_REJECTED);
      return true;
    },
  );
});

test("a week outside the current/next Shanghai week is rejected", async () => {
  const staleWeek = addDays(currentWeekStart(), 21);
  const handler = createWeeklyPlanJobHandler({
    graph: completedGraph(staleWeek),
    insertDraft: async () => "draft-1",
  });
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
