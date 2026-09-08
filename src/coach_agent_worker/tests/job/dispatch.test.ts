import assert from "node:assert/strict";
import test from "node:test";
import { PlanJobDispatcher } from "../../src/job/dispatch.js";
import { ERROR_CODES, type Handler, newPermanentError } from "../../src/job/errors.js";
import type { PlanJobMessage } from "../../src/job/model.js";
import { FakePlanJobStore, FakePublisher } from "./fakes.js";

const POLICY = { maxAttempts: 2, baseBackoffMs: 10_000, maxBackoffMs: 60_000 };

function dispatcher(store: FakePlanJobStore, publisher: FakePublisher, registry: Map<string, Handler>, now = () => new Date()) {
  return new PlanJobDispatcher(store, registry, publisher, POLICY, { now });
}

const msg = (jobId: string, userId = "user-1"): PlanJobMessage => ({ jobId, userId });

test("queued job is claimed, handler runs, job finishes done with its draft id", async () => {
  const store = new FakePlanJobStore();
  const job = FakePlanJobStore.fixture();
  await store.create(job);
  const publisher = new FakePublisher();
  let seenInput: string | null = null;
  const handler: Handler = async (j, hb) => {
    seenInput = j.inputJson;
    await hb("reading_history", 10);
    await hb("evaluating", 55);
    return { result: JSON.stringify({ ok: true }), draftId: "draft-1" };
  };
  await dispatcher(store, publisher, new Map([["generate_master_plan", handler]])).dispatch(msg("job-1"));

  const done = store.rows.get("job-1")!;
  assert.equal(done.status, "done");
  assert.equal(done.attempts, 1);
  assert.equal(done.progressPct, 100);
  assert.equal(done.stage, "outputting");
  assert.equal(done.resultJson, JSON.stringify({ ok: true }));
  assert.deepEqual(publisher.work, []);
  assert.equal(seenInput, "{}");
  assert.ok(done.completedAt !== null);
});

test("progress is persisted monotonic and regressive updates are ignored", async () => {
  const store = new FakePlanJobStore();
  await store.create(FakePlanJobStore.fixture());
  const publisher = new FakePublisher();
  // End with a permanent failure so finishDone does not overwrite stage/progress —
  // the persisted row reflects exactly what the heartbeats wrote during the run.
  const handler: Handler = async (_j, hb) => {
    await hb("reading_history", 10);
    await hb("evaluating", 30);
    await hb("evaluating", 20); // regressive → ignored
    await hb("planning_phases", 60);
    throw newPermanentError(ERROR_CODES.KERNEL_NOT_COMPLETED, new Error("goal_conflict"));
  };
  await dispatcher(store, publisher, new Map([["generate_master_plan", handler]])).dispatch(msg("job-1"));

  const done = store.rows.get("job-1")!;
  assert.equal(done.status, "failed");
  assert.equal(done.stage, "planning_phases");
  assert.equal(done.progressPct, 60);
});

test("duplicate pointer for a terminal job is dropped", async () => {
  const store = new FakePlanJobStore();
  const job = FakePlanJobStore.fixture({ status: "done", resultJson: "ok" });
  await store.create(job);
  const publisher = new FakePublisher();
  let calls = 0;
  const handler: Handler = async () => {
    calls += 1;
    return { result: "ok" };
  };
  await dispatcher(store, publisher, new Map([["generate_master_plan", handler]])).dispatch(msg("job-1"));
  assert.equal(calls, 0);
  assert.deepEqual(store.claims, []);
});

test("orphan pointer is dropped without a handler call", async () => {
  const store = new FakePlanJobStore();
  const publisher = new FakePublisher();
  const handler: Handler = async () => ({ result: "ok" });
  await dispatcher(store, publisher, new Map([["generate_master_plan", handler]])).dispatch(msg("missing"));
  assert.equal(store.rows.size, 0);
  assert.equal(publisher.work.length, 0);
});

test("missing handler fails terminally with a stable code, no retry", async () => {
  const store = new FakePlanJobStore();
  await store.create(FakePlanJobStore.fixture());
  const publisher = new FakePublisher();
  await dispatcher(store, publisher, new Map()).dispatch(msg("job-1"));

  const done = store.rows.get("job-1")!;
  assert.equal(done.status, "failed");
  assert.equal(done.errorCode, ERROR_CODES.NO_HANDLER);
  assert.deepEqual(publisher.retries, []);
  assert.deepEqual(publisher.poisons, []);
});

test("permanent error fails terminally with the stable code and never retries", async () => {
  const store = new FakePlanJobStore();
  await store.create(FakePlanJobStore.fixture());
  const publisher = new FakePublisher();
  const handler: Handler = async () => {
    throw newPermanentError(ERROR_CODES.KERNEL_NOT_COMPLETED, new Error("goal_conflict"));
  };
  await dispatcher(store, publisher, new Map([["generate_master_plan", handler]])).dispatch(msg("job-1"));

  const done = store.rows.get("job-1")!;
  assert.equal(done.status, "failed");
  assert.equal(done.errorCode, ERROR_CODES.KERNEL_NOT_COMPLETED);
  assert.deepEqual(publisher.retries, []);
  assert.deepEqual(publisher.poisons, []);
});

test("transient infra error schedules a retry on the first attempt", async () => {
  const store = new FakePlanJobStore();
  await store.create(FakePlanJobStore.fixture());
  const publisher = new FakePublisher();
  const handler: Handler = async () => {
    throw new Error("mysql connection reset");
  };
  await dispatcher(store, publisher, new Map([["generate_master_plan", handler]])).dispatch(msg("job-1"));

  const retried = store.rows.get("job-1")!;
  assert.equal(retried.status, "queued");
  assert.equal(retried.errorCode, "retryable");
  assert.equal(retried.attempts, 1);
  assert.deepEqual(publisher.retries, [{ message: msg("job-1"), delayMs: 10_000 }]);
});

test("transient infra error on the final attempt poisons the job", async () => {
  const store = new FakePlanJobStore();
  // Second attempt: queued with attempts=1 so the claim succeeds at attempt 2,
  // then the transient failure exhausts the ≤2 budget and poisons.
  await store.create(FakePlanJobStore.fixture({ attempts: 1, status: "queued" }));
  const publisher = new FakePublisher();
  const handler: Handler = async () => {
    throw new Error("mysql connection reset");
  };
  await dispatcher(store, publisher, new Map([["generate_master_plan", handler]])).dispatch(msg("job-1"));

  const poisoned = store.rows.get("job-1")!;
  assert.equal(poisoned.status, "failed");
  assert.equal(poisoned.errorCode, "poison");
  assert.deepEqual(publisher.poisons, [msg("job-1")]);
  assert.deepEqual(publisher.retries, []);
});

test("redelivered pointer for a running job resumes it (worker crash recovery)", async () => {
  const store = new FakePlanJobStore();
  const clock = new Date("2026-09-01T00:00:00.000Z");
  await store.create(
    FakePlanJobStore.fixture({
      status: "running",
      attempts: 1,
      heartbeatAt: clock, // even a fresh heartbeat: redelivery means the holder is gone
    }),
  );
  const publisher = new FakePublisher();
  let calls = 0;
  const handler: Handler = async (j) => {
    calls += 1;
    assert.equal(j.attempts, 2);
    return { result: "ok" };
  };
  await dispatcher(store, publisher, new Map([["generate_master_plan", handler]]), () => clock).dispatch(msg("job-1"));
  assert.equal(calls, 1);
  assert.deepEqual(store.reclaims, ["job-1"]);
  const done = store.rows.get("job-1")!;
  assert.equal(done.status, "done");
  assert.equal(done.attempts, 2);
});

test("redelivered pointer beyond the attempts budget is dropped (left for the reconcile)", async () => {
  const store = new FakePlanJobStore();
  await store.create(FakePlanJobStore.fixture({ status: "running", attempts: 2, heartbeatAt: new Date() }));
  const publisher = new FakePublisher();
  let calls = 0;
  const handler: Handler = async () => {
    calls += 1;
    return { result: "ok" };
  };
  await dispatcher(store, publisher, new Map([["generate_master_plan", handler]]), () => new Date()).dispatch(msg("job-1"));
  assert.equal(calls, 0);
  assert.deepEqual(store.reclaims, []);
});

test("store fault during claim propagates as an infra fault (nack/requeue)", async () => {
  const store = new FakePlanJobStore();
  await store.create(FakePlanJobStore.fixture());
  store.faultClaim = true;
  const publisher = new FakePublisher();
  const handler: Handler = async () => ({ result: "ok" });
  await assert.rejects(dispatcher(store, publisher, new Map([["generate_master_plan", handler]])).dispatch(msg("job-1")), /store unavailable/);
});

test("reconcile fails stale running jobs with the heartbeat code", async () => {
  const store = new FakePlanJobStore();
  const clock = new Date("2026-09-01T00:00:00.000Z");
  await store.create(
    FakePlanJobStore.fixture({
      jobId: "stale",
      status: "running",
      heartbeatAt: new Date(clock.getTime() - 600_000),
    }),
  );
  await store.create(FakePlanJobStore.fixture({ jobId: "fresh", status: "running", heartbeatAt: clock }));
  const failed = await store.failStaleRunning(new Date(clock.getTime() - 300_000), clock, ERROR_CODES.HEARTBEAT_TIMEOUT);
  assert.equal(failed, 1);
  assert.equal(store.rows.get("stale")!.status, "failed");
  assert.equal(store.rows.get("stale")!.errorCode, ERROR_CODES.HEARTBEAT_TIMEOUT);
  assert.equal(store.rows.get("fresh")!.status, "running");
});
