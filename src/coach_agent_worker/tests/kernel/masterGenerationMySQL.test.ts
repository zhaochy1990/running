import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MasterPlanGraphRequest } from "@stride/coach-agent";
import { createTestCompletedOutcomeV3, createTestRequest } from "@stride/coach-agent/test-fixtures";
import mysql from "mysql2/promise";
import { createMasterPlanJobHandler } from "../../src/kernel/master/handler.js";
import { FakePlanJobStore } from "../job/fakes.js";

const url = process.env.STRIDE_955_ISOLATED_MYSQL_URL;

test("candidate generation, retry and failure leave real existing and empty plan tables unchanged", { skip: !url }, async () => {
  if (!url) throw new Error("missing isolated MySQL URL");
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !/^\/(stride_issue_955|[\w-]+_test)$/.test(parsed.pathname)) {
    throw new Error("STRIDE_955_ISOLATED_MYSQL_URL must point to an isolated local test database");
  }
  const db = await mysql.createConnection(url);
  const existingUser = randomUUID();
  const emptyUser = randomUUID();
  const master = randomUUID();
  const week = randomUUID();
  const workout = randomUUID();
  const goal = randomUUID();
  try {
    await db.execute(
      "INSERT INTO master_plan (plan_id,user_id,content_version,content,goal_id,status,active_flag,revision,created_at,updated_at) VALUES (?,?,2,'{}',?,'active',1,1,NOW(3),NOW(3))",
      [master, existingUser, goal],
    );
    await db.execute(
      "INSERT INTO weekly_plan (plan_id,user_id,master_plan_id,week_start,content_version,content,status,status_slot,revision,created_at,updated_at) VALUES (?,?,?,'2026-08-10',2,'{}','active','active',1,NOW(3),NOW(3))",
      [week, existingUser, master],
    );
    await db.execute(
      "INSERT INTO workout (workout_id,user_id,date,source,kind,name,status,plan_id,session_index,created_at,updated_at) VALUES (?,?,'2026-08-10','weekly','run','old','active',?,0,NOW(3),NOW(3))",
      [workout, existingUser, week],
    );
    const snapshot = async () => {
      const [masters] = await db.execute("SELECT * FROM master_plan WHERE user_id IN (?,?) ORDER BY plan_id", [existingUser, emptyUser]);
      const [weeks] = await db.execute("SELECT * FROM weekly_plan WHERE user_id IN (?,?) ORDER BY plan_id", [existingUser, emptyUser]);
      const [workouts] = await db.execute("SELECT * FROM workout WHERE user_id IN (?,?) ORDER BY workout_id", [existingUser, emptyUser]);
      return { masters, weeks, workouts };
    };
    const before = await snapshot();
    const outcome = createTestCompletedOutcomeV3({ totalWeeks: 2, weeklyDocs: 2 });
    const graph = {
      async stream() {
        return (async function* () {
          yield { finalize: { outcome } };
        })();
      },
    };
    const handler = createMasterPlanJobHandler({ graph: graph as never, resolveGoalId: async () => goal });
    const inputJson = JSON.stringify(MasterPlanGraphRequest.parse(createTestRequest()));
    for (const userId of [emptyUser, existingUser, existingUser]) {
      const job = FakePlanJobStore.fixture({ userId, jobId: randomUUID(), inputJson });
      const result = await handler(job, async () => {});
      assert.deepEqual(JSON.parse(result.result).content.weekly_docs, outcome.artifact.weekly_docs);
      assert.deepEqual(await snapshot(), before);
    }
    const failure = createMasterPlanJobHandler({ graph: graph as never, resolveGoalId: async () => null });
    await assert.rejects(failure(FakePlanJobStore.fixture({ userId: existingUser, jobId: randomUUID(), inputJson }), async () => {}));
    assert.deepEqual(await snapshot(), before);
  } finally {
    await db.execute("DELETE FROM workout WHERE user_id IN (?,?)", [existingUser, emptyUser]);
    await db.execute("DELETE FROM weekly_plan WHERE user_id IN (?,?)", [existingUser, emptyUser]);
    await db.execute("DELETE FROM master_plan WHERE user_id IN (?,?)", [existingUser, emptyUser]);
    await db.end();
  }
});
