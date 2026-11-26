import assert from "node:assert/strict";
import test from "node:test";
import { EvalApiClient } from "../../src/eval/client.js";
import { decodeExecutionMessage, encodeExecutionMessage } from "../../src/eval/codec.js";
import { resolveWorkerMode } from "../../src/eval/config.js";
import { receipt } from "./fixtures.js";

test("worker mode defaults to prod; eval is explicit; anything else refuses to boot", () => {
  assert.equal(resolveWorkerMode({}), "prod");
  assert.equal(resolveWorkerMode({ PLAN_WORKER_MODE: "eval" }), "eval");
  assert.throws(() => resolveWorkerMode({ PLAN_WORKER_MODE: " Eval " }), /Unsupported PLAN_WORKER_MODE/);
});

test("eval pointer message round-trips and refuses unknown shapes", () => {
  const decoded = decodeExecutionMessage(encodeExecutionMessage("exec-1"));
  assert.deepEqual(decoded, { schema_version: 1, snapshot_execution_id: "exec-1" });
  for (const body of [
    "not json",
    JSON.stringify({ schema_version: 2, snapshot_execution_id: "x" }),
    JSON.stringify({ schema_version: 1 }),
    JSON.stringify({ schema_version: 1, snapshot_execution_id: "x", extra: 1 }),
  ]) {
    assert.throws(() => decodeExecutionMessage(Buffer.from(body)));
  }
});

function stubClient(responses: Array<[number, unknown]>, captured: Array<{ method: string; path: string; body: unknown; token: string | undefined }>) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    captured.push({
      method: init.method ?? "",
      path: new URL(url).pathname,
      body: JSON.parse(String(init.body)),
      token: (init.headers as Record<string, string>)["x-plan-eval-token"],
    });
    const [status, body] = responses.shift() ?? [500, { error: "no stub" }];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return new EvalApiClient("http://plan-eval-api:8080/", "worker-secret", fetchImpl);
}

test("claim maps the API's answers onto leased / busy / terminal / missing and surfaces version rejection", async () => {
  const captured: Parameters<typeof stubClient>[1] = [];
  const leased = {
    status: "leased",
    lease_epoch: 3,
    lease_expires_at: "2026-11-24T00:01:00.000Z",
    input: { artifact_type: "master_plan", request: {}, snapshot: {}, as_of: "2026-10-23T23:59:59+08:00" },
  };
  const client = stubClient(
    [
      [200, leased],
      [200, { status: "busy", retry_after_ms: 1500 }],
      [200, { status: "terminal", generate_status: "failed", artifact_id: null }],
      [404, { error: "execution_not_found" }],
      [409, { error: "agent_version_mismatch" }],
    ],
    captured,
  );
  assert.deepEqual(await client.claim("exec-1", "2026.11.30", "worker-1", "claim-1"), leased);
  assert.deepEqual(await client.claim("exec-1", "2026.11.30", "worker-1", "claim-1"), { status: "busy", retry_after_ms: 1500 });
  assert.deepEqual(await client.claim("exec-1", "2026.11.30", "worker-1", "claim-1"), { status: "terminal", generate_status: "failed", artifact_id: null });
  assert.deepEqual(await client.claim("exec-1", "2026.11.30", "worker-1", "claim-1"), { status: "missing" });
  await assert.rejects(client.claim("exec-1", "2026.11.29", "worker-1", "claim-1"), /plan-eval api 409 agent_version_mismatch/);
  assert.deepEqual(captured[0], {
    method: "POST",
    path: "/api/internal/plan-eval/executions/claim",
    body: { snapshot_execution_id: "exec-1", agent_version: "2026.11.30", worker_id: "worker-1", claim_request_id: "claim-1" },
    token: "worker-secret",
  });
});

test("submit returns the persisted receipt; renew/submit 409 is a stale lease, submit 404 is a vanished execution", async () => {
  const captured: Parameters<typeof stubClient>[1] = [];
  const result = { kind: "failed", error: { code: "kernel_goal_conflict", message: "kernel returned goal_conflict" } } as const;
  const client = stubClient(
    [
      [200, { lease_expires_at: "2026-11-24T00:02:00.000Z" }],
      [409, { error: "stale_lease" }],
      [200, receipt],
      [409, { error: "stale_lease" }],
      [404, { error: "execution_not_found" }],
      [503, { error: "down" }],
    ],
    captured,
  );
  await client.renew("exec-1", { agent_version: "2026.11.30", worker_id: "worker-1", lease_epoch: 1 });
  await assert.rejects(client.renew("exec-1", { agent_version: "2026.11.30", worker_id: "worker-1", lease_epoch: 1 }), { name: "StaleLeaseError" });
  assert.deepEqual(await client.submit("exec-1", { agent_version: "2026.11.30", worker_id: "worker-1", lease_epoch: 1 }, result, "submit-1"), receipt);
  assert.deepEqual(captured[2]?.body, { agent_version: "2026.11.30", worker_id: "worker-1", lease_epoch: 1, result, submit_id: "submit-1" });
  await assert.rejects(client.submit("exec-1", { agent_version: "2026.11.30", worker_id: "worker-1", lease_epoch: 1 }, result, "submit-1"), {
    name: "StaleLeaseError",
  });
  await assert.rejects(client.submit("exec-1", { agent_version: "2026.11.30", worker_id: "worker-1", lease_epoch: 1 }, result, "submit-1"), {
    name: "MissingExecutionError",
  });
  await assert.rejects(
    client.submit("exec-1", { agent_version: "2026.11.30", worker_id: "worker-1", lease_epoch: 1 }, result, "submit-1"),
    /plan-eval api 503 down/,
  );
});

test("lost transport responses retry identical claim and submit IDs", async () => {
  const calls: string[] = [];
  let attempts = 0;
  const client = new EvalApiClient("http://plan-eval-api:8080", "version-token", (async (_url, init) => {
    calls.push(String(init?.body));
    attempts++;
    if (attempts % 2 === 1) throw new TypeError("response lost");
    return new Response(JSON.stringify(attempts === 2 ? { status: "terminal", generate_status: "failed", artifact_id: null } : receipt), { status: 200 });
  }) as typeof fetch);
  await client.claim("exec-1", "2026.11.30", "worker-1", "claim-1");
  await client.submit(
    "exec-1",
    { agent_version: "2026.11.30", worker_id: "worker-1", lease_epoch: 1 },
    { kind: "failed", error: { code: "timeout", message: "model timed out" } },
    "submit-1",
  );
  assert.equal(calls[0], calls[1]);
  assert.equal(calls[2], calls[3]);
});

test("claim accepts a frozen rolling execution without turning it into a broker retry", async () => {
  const leased = {
    status: "leased",
    lease_epoch: 1,
    lease_expires_at: "2026-11-24T00:01:00Z",
    input: {
      artifact_type: "weekly_plan_batch",
      request: { request_id: "rolling", as_of: "2026-10-26T08:00:00+08:00" },
      snapshot: {},
      as_of: "2026-10-26T08:00:00+08:00",
    },
  };
  assert.deepEqual(await stubClient([[200, leased]], []).claim("exec-rolling", "2026.11.30", "worker"), leased);
});
