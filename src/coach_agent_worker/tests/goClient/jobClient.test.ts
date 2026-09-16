import assert from "node:assert/strict";
import test from "node:test";
import { GoJobClient } from "../../src/goClient/jobClient.js";
import { asPermanent, ERROR_CODES } from "../../src/job/errors.js";
import { JobStateChangedError } from "../../src/job/ports.js";

const row = (overrides: Record<string, unknown> = {}) => ({
  job_id: "job-1",
  user_id: "user-1",
  job_type: "generate_weekly_plan",
  status: "queued",
  attempts: 0,
  stage: "",
  progress_pct: 0,
  input_json: "{}",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  ...overrides,
});

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

/** Captures the request and answers with one canned response. */
function captureFetch(status: number, body: unknown, captured: { url: string; init: RequestInit }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = String(url);
    captured.init = init ?? {};
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("create posts the row to the Go internal endpoint with the internal token", async () => {
  const captured = { url: "", init: {} as RequestInit };
  const client = new GoJobClient("http://go-api:8080", "secret-token", captureFetch(201, { job_id: "job-1", created: true }, captured));

  const result = await client.create({
    jobId: "job-1",
    userId: "user-1",
    jobType: "generate_weekly_plan",
    status: "queued",
    attempts: 0,
    stage: "",
    progressPct: 0,
    inputJson: `{"request_id":"r"}`,
    resultJson: null,
    errorCode: null,
    errorMessage: null,
    idempotencyKey: "key-1",
    heartbeatAt: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    completedAt: null,
  });

  assert.deepEqual(result, { jobId: "job-1", created: true });
  assert.equal(captured.url, "http://go-api:8080/api/internal/jobs");
  assert.equal((captured.init.headers as Record<string, string>)["x-internal-token"], "secret-token");
  const body = JSON.parse(String(captured.init.body)) as Record<string, unknown>;
  assert.equal(body.job_id, "job-1");
  assert.equal(body.user_id, "user-1");
  assert.equal(body.job_type, "generate_weekly_plan");
  assert.equal(body.idempotency_key, "key-1");
});

test("an idempotent 200 create reports created=false so the caller does not republish", async () => {
  const client = new GoJobClient("http://go-api", "t", fakeFetch(200, { job_id: "existing", created: false }));
  const result = await client.create({
    jobId: "job-1",
    userId: "user-1",
    jobType: "generate_weekly_plan",
    status: "queued",
    attempts: 0,
    stage: "",
    progressPct: 0,
    inputJson: "{}",
    resultJson: null,
    errorCode: null,
    errorMessage: null,
    idempotencyKey: "dup",
    heartbeatAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
  });
  assert.deepEqual(result, { jobId: "existing", created: false });
});

test("transition maps camelCase deltas onto the snake_case wire contract", async () => {
  const captured = { url: "", init: {} as RequestInit };
  const client = new GoJobClient("http://go-api:8080", "t", captureFetch(200, row({ status: "running", attempts: 1 }), captured));

  await client.transition("job-1", {
    from: "queued",
    to: "running",
    attemptsDelta: 1,
    attemptsLt: 2,
    stage: "planning",
    progressPct: 10,
    clearError: true,
    heartbeatAt: new Date("2026-09-01T00:00:05.000Z"),
  });

  assert.equal(captured.url, "http://go-api:8080/api/internal/jobs/job-1/transition");
  assert.deepEqual(JSON.parse(String(captured.init.body)), {
    to: "running",
    from: "queued",
    attempts_delta: 1,
    attempts_lt: 2,
    stage: "planning",
    progress_pct: 10,
    clear_error: true,
    heartbeat_at: "2026-09-01T00:00:05.000Z",
  });
});

test("only the fields the caller set are sent, so a heartbeat cannot clear unrelated columns", async () => {
  const captured = { url: "", init: {} as RequestInit };
  const client = new GoJobClient("http://go-api", "t", captureFetch(200, row(), captured));
  await client.transition("job-1", { to: "running", stage: "evaluating", progressPct: 30 });
  assert.deepEqual(JSON.parse(String(captured.init.body)), { to: "running", stage: "evaluating", progress_pct: 30 });
});

test("a 409 CAS failure surfaces as JobStateChangedError, not a retryable fault", async () => {
  const client = new GoJobClient("http://go-api", "t", fakeFetch(409, { error: "job_state_changed" }));
  await assert.rejects(client.transition("job-1", { from: "queued", to: "running" }), (error: unknown) => {
    assert.ok(error instanceof JobStateChangedError);
    assert.equal(asPermanent(error), null);
    return true;
  });
});

test("a 404 transition is permanent: the row is gone and retrying cannot help", async () => {
  const client = new GoJobClient("http://go-api", "t", fakeFetch(404, { error: "not found" }));
  await assert.rejects(client.transition("job-1", { to: "running" }), (error: unknown) => {
    assert.equal(asPermanent(error)?.code, ERROR_CODES.JOB_NOT_FOUND);
    return true;
  });
});

test("a 400 transition is permanent with the rejected code", async () => {
  const client = new GoJobClient("http://go-api", "t", fakeFetch(400, { error: "invalid request body" }));
  await assert.rejects(client.transition("job-1", { to: "running" }), (error: unknown) => {
    assert.equal(asPermanent(error)?.code, ERROR_CODES.JOB_STATE_REJECTED);
    return true;
  });
});

test("a 5xx transition stays retryable", async () => {
  const client = new GoJobClient("http://go-api", "t", fakeFetch(503, { error: "boom" }));
  await assert.rejects(client.transition("job-1", { to: "running" }), (error: unknown) => {
    assert.equal(asPermanent(error), null);
    return true;
  });
});

test("get returns the domain row and maps a missing job to null", async () => {
  const client = new GoJobClient(
    "http://go-api",
    "t",
    fakeFetch(200, row({ status: "done", progress_pct: 100, result_json: `{"draft_id":"d-1"}`, completed_at: "2026-09-01T00:10:00Z" })),
  );
  const job = await client.get("job-1");
  assert.equal(job?.status, "done");
  assert.equal(job?.progressPct, 100);
  assert.equal(job?.resultJson, `{"draft_id":"d-1"}`);
  assert.equal(job?.completedAt?.toISOString(), "2026-09-01T00:10:00.000Z");
  assert.equal(job?.errorCode, null);

  const missing = new GoJobClient("http://go-api", "t", fakeFetch(404, { error: "not found" }));
  assert.equal(await missing.get("job-1"), null);
});

test("failStaleRunning posts the window and returns the failed count", async () => {
  const captured = { url: "", init: {} as RequestInit };
  const client = new GoJobClient("http://go-api:8080", "t", captureFetch(200, { failed: 3 }, captured));

  const failed = await client.failStaleRunning(new Date("2026-09-01T00:05:00.000Z"), new Date("2026-09-01T00:15:00.000Z"), "heartbeat_timeout");

  assert.equal(failed, 3);
  assert.equal(captured.url, "http://go-api:8080/api/internal/jobs/stale-running");
  assert.deepEqual(JSON.parse(String(captured.init.body)), {
    older_than: "2026-09-01T00:05:00.000Z",
    error_code: "heartbeat_timeout",
    job_types: ["generate_master_plan", "generate_weekly_plan"],
  });
});
