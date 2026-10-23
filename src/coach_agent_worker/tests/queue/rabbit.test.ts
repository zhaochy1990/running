import assert from "node:assert/strict";
import test from "node:test";
import type { ChannelModel } from "amqplib";
import { PlanJobQueue } from "../../src/queue/rabbit.js";

const fakeModel = (): ChannelModel => ({ once: () => undefined }) as unknown as ChannelModel;

test("connectWithRetry retries with doubling delays until the broker answers", async () => {
  const failures = [new Error("refused"), new Error("refused")];
  let dialed = 0;
  const connect = async (): Promise<ChannelModel> => {
    dialed += 1;
    const failure = failures[dialed - 1];
    if (failure) throw failure;
    return fakeModel();
  };
  const waits: number[] = [];

  const queue = await PlanJobQueue.connectWithRetry("amqp://x", {
    connect,
    sleep: async (ms) => void waits.push(ms),
  });

  assert.ok(queue instanceof PlanJobQueue);
  assert.equal(dialed, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
});

test("connectWithRetry caps the delay, keeps the cause, and gives up after the budget", async () => {
  const refusal = new Error("final refusal");
  const connect = async (): Promise<ChannelModel> => {
    throw refusal;
  };
  const waits: number[] = [];

  await assert.rejects(PlanJobQueue.connectWithRetry("amqp://x", { connect, sleep: async (ms) => void waits.push(ms) }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /after 10 attempts/);
    assert.equal(error.cause, refusal);
    return true;
  });
  // 10 attempts → 9 waits: 1s,2s,4s,8s,16s, then capped at 30s
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000]);
});
