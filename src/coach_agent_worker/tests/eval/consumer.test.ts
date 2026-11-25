import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "amqplib";
import { encodeExecutionMessage } from "../../src/eval/codec.js";
import { handleEvalDelivery } from "../../src/eval/consumer.js";

function delivery(body: Buffer | string) {
  return { content: typeof body === "string" ? Buffer.from(body) : body } as Message;
}

test("ack follows a handler that returns; a fault backs off then requeues; an undecodable pointer is dropped", async () => {
  const log: string[] = [];
  const ch = { ack: () => void log.push("ack"), nack: () => void log.push("nack"), reject: () => void log.push("reject") };
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
    log.push(`sleep:${ms}`);
  };

  await handleEvalDelivery(ch, delivery(encodeExecutionMessage("exec-1")), async () => {}, 5_000, sleep);
  await handleEvalDelivery(
    ch,
    delivery(encodeExecutionMessage("exec-1")),
    async () => {
      throw new Error("plan-eval api down");
    },
    5_000,
    sleep,
  );
  await handleEvalDelivery(
    ch,
    delivery("{not json"),
    async () => {
      throw new Error("must not run");
    },
    5_000,
    sleep,
  );

  assert.deepEqual(log, ["ack", "sleep:5000", "nack", "reject"]);
  assert.deepEqual(slept, [5_000]);
});
