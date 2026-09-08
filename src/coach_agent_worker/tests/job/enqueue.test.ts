import assert from "node:assert/strict";
import test from "node:test";
import { PlanJobEnqueuer } from "../../src/job/enqueue.js";
import { FakePlanJobStore, FakePublisher } from "./fakes.js";

test("enqueue is store-first: the job row is durably queued before the pointer is published", async () => {
  const store = new FakePlanJobStore();
  const publisher = new FakePublisher();
  const enqueuer = new PlanJobEnqueuer(store, publisher, () => new Date("2026-09-01T00:00:00.000Z"));

  const { jobId, estimatedDurationSeconds } = await enqueuer.enqueue(
    { jobType: "generate_master_plan", userId: "user-1", inputJson: JSON.stringify({ a: 1 }), idempotencyKey: "key-1" },
    300,
  );

  assert.match(jobId, /^[0-9a-f-]{36}$/);
  assert.equal(estimatedDurationSeconds, 300);
  const row = store.rows.get(jobId)!;
  assert.equal(row.status, "queued");
  assert.equal(row.attempts, 0);
  assert.equal(row.idempotencyKey, "key-1");
  assert.deepEqual(publisher.work, [{ jobId, userId: "user-1" }]);
});

test("duplicate idempotency key returns the existing job id without publishing again", async () => {
  const store = new FakePlanJobStore();
  const publisher = new FakePublisher();
  const enqueuer = new PlanJobEnqueuer(store, publisher);

  const first = await enqueuer.enqueue({ jobType: "generate_master_plan", userId: "user-1", inputJson: "{}", idempotencyKey: "dup" }, 300);
  const second = await enqueuer.enqueue({ jobType: "generate_master_plan", userId: "user-1", inputJson: "{}", idempotencyKey: "dup" }, 300);

  assert.equal(second.jobId, first.jobId);
  assert.equal(publisher.work.length, 1);
});

test("publish failure fail-closes the row so the pointer can never execute", async () => {
  const store = new FakePlanJobStore();
  const publisher = new FakePublisher();
  publisher.failPublish = true;
  const enqueuer = new PlanJobEnqueuer(store, publisher, () => new Date("2026-09-01T00:00:00.000Z"));

  await assert.rejects(enqueuer.enqueue({ jobType: "generate_master_plan", userId: "user-1", inputJson: "{}" }, 300), /publish failed/);

  const row = store.rows.get([...store.rows.keys()][0]!)!;
  assert.equal(row.status, "failed");
  assert.equal(row.errorCode, "publish_failed");
});
