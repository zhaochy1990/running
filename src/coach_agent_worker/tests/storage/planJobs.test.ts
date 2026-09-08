import assert from "node:assert/strict";
import test from "node:test";
import { IdempotencyConflictError } from "../../src/job/ports.js";
import { MySqlPlanJobStore } from "../../src/storage/planJobs.js";
import { FakePlanJobStore } from "../job/fakes.js";

const ROW = {
  job_id: "job-1",
  user_id: "user-1",
  job_type: "generate_master_plan",
  status: "queued",
  attempts: 0,
  stage: "",
  progress_pct: 0,
  input_json: "{}",
  result_json: null,
  error_code: null,
  error_message: null,
  idempotency_key: "key-1",
  heartbeat_at: null,
  created_at: new Date("2026-09-01T00:00:00.000Z"),
  updated_at: new Date("2026-09-01T00:00:00.000Z"),
  completed_at: null,
};

test("setup creates the plan_jobs table idempotently", async () => {
  const seen: string[] = [];
  const pool = {
    async query(sql: string) {
      seen.push(sql);
      return [[]];
    },
  } as never;
  const store = new MySqlPlanJobStore(pool);
  await store.setup();
  assert.match(seen[0] ?? "", /CREATE TABLE IF NOT EXISTS plan_jobs/);
  assert.match(seen[0] ?? "", /UNIQUE KEY uq_plan_jobs_user_idem \(user_id, idempotency_key\)/);
});

test("claim is a queued→running CAS guarded by attempts+1", async () => {
  const executed: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    async execute(sql: string, values: unknown[]) {
      executed.push({ sql, values });
      return [sql.includes("status='queued'") ? { affectedRows: 1 } : { affectedRows: 0 }];
    },
    async query() {
      return [[ROW]];
    },
  } as never;
  const store = new MySqlPlanJobStore(pool);
  const result = await store.claim("job-1", new Date("2026-09-01T00:00:00.000Z"));
  assert.equal(result.claimed, true);
  assert.ok(result.claimed);
  assert.equal(result.job.jobId, "job-1");
  assert.match(executed[0]?.sql ?? "", /attempts=attempts\+1/);
  assert.match(executed[0]?.sql ?? "", /AND status='queued'/);
});

test("reclaim matches running rows only within the attempts budget", async () => {
  const executed: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    async execute(sql: string, values: unknown[]) {
      executed.push({ sql, values });
      return [sql.includes("attempts < ?") ? { affectedRows: 1 } : { affectedRows: 0 }];
    },
    async query() {
      return [[ROW]];
    },
  } as never;
  const store = new MySqlPlanJobStore(pool);
  await store.reclaimRunning("job-1", new Date("2026-09-01T00:05:00.000Z"), 2);
  assert.match(executed[0]?.sql ?? "", /status='running/);
  assert.match(executed[0]?.sql ?? "", /attempts < \?/);
});

test("create translates a duplicate (user, idempotency_key) into a conflict carrying the existing id", async () => {
  const pool = {
    async execute() {
      const err = new Error("dup") as Error & { code: string };
      err.code = "ER_DUP_ENTRY";
      throw err;
    },
    async query() {
      return [[ROW]];
    },
  } as never;
  const store = new MySqlPlanJobStore(pool);
  const job = FakePlanJobStore.fixture({ idempotencyKey: "key-1" });
  await assert.rejects(store.create(job), (error: unknown) => {
    assert.ok(error instanceof IdempotencyConflictError);
    assert.equal(error.jobId, "job-1");
    return true;
  });
});

test("failStaleRunning binds one value per placeholder (incl. updated_at=now)", async () => {
  const now = new Date("2026-09-01T00:05:00.000Z");
  const executed: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    async execute(sql: string, values: unknown[]) {
      executed.push({ sql, values });
      return [{ affectedRows: 2 }];
    },
  } as never;
  const store = new MySqlPlanJobStore(pool);
  const failed = await store.failStaleRunning(new Date("2026-09-01T00:00:00.000Z"), now, "heartbeat_timeout");
  assert.equal(failed, 2);
  assert.match(executed[0]?.sql ?? "", /heartbeat_at IS NOT NULL AND heartbeat_at < \?/);
  // 5 placeholders (error_code, error_message, completed_at, updated_at, heartbeat_at) —
  // a bind-count mismatch makes mysql2 reject the statement every cycle.
  const placeholders = (executed[0]?.sql.match(/\?/g) ?? []).length;
  assert.equal(executed[0]?.values.length, 5);
  assert.equal(placeholders, executed[0]!.values.length);
  // completed_at and updated_at are both bound to `now`, not to the cutoff.
  assert.equal(executed[0]?.values[2], now);
  assert.equal(executed[0]?.values[3], now);
});
