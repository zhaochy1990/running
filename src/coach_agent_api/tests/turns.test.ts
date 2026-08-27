import assert from "node:assert/strict";
import test from "node:test";
import { CoordinatedTurnRunner } from "../src/turn/coordinator.js";
import { TurnConflictError } from "../src/turn/errors.js";
import type { TurnReceipt } from "../src/turn/receipt.js";
import type { ThreadLock, TurnReceiptStore, TurnRecovery } from "../src/turn/receiptStore.js";

class MemoryReceipts implements TurnReceiptStore {
  readonly values = new Map<string, TurnReceipt>();
  get(threadId: string, turnId: string) {
    return Promise.resolve(this.values.get(`${threadId}:${turnId}`));
  }
  recovery: TurnRecovery | undefined;
  recover(): Promise<TurnRecovery | undefined> {
    return Promise.resolve(this.recovery);
  }
  put(threadId: string, turnId: string, receipt: TurnReceipt) {
    this.values.set(`${threadId}:${turnId}`, receipt);
    return Promise.resolve();
  }
  prune() {
    return Promise.resolve();
  }
}

test("a completed checkpoint repairs a missing receipt without invoking", async () => {
  const receipts = new MemoryReceipts();
  receipts.recovery = {
    kind: "complete" as const,
    receipt: { fingerprint: "a", response: { answer: 1 } },
  };
  const runner = new CoordinatedTurnRunner(receipts, new MemoryThreadLock());
  let calls = 0;
  assert.deepEqual(await runner.run({ threadId: "thread", clientTurnId: "turn", fingerprint: "a" }, async () => ({ answer: ++calls })), { answer: 1 });
  assert.equal(calls, 0);
  assert.deepEqual(receipts.values.get("thread:turn"), {
    fingerprint: "a",
    response: { answer: 1 },
  });
});

test("an incomplete checkpoint resumes instead of appending the input again", async () => {
  const receipts = new MemoryReceipts();
  receipts.recovery = { kind: "incomplete", fingerprint: "a" };
  const runner = new CoordinatedTurnRunner(receipts, new MemoryThreadLock());
  let resumed = false;
  await runner.run({ threadId: "thread", clientTurnId: "turn", fingerprint: "a" }, async (resumeFromCheckpoint) => {
    resumed = resumeFromCheckpoint;
    return { answer: 1 };
  });
  assert.equal(resumed, true);
});

test("a recovered checkpoint with a changed request conflicts", async () => {
  const receipts = new MemoryReceipts();
  receipts.recovery = { kind: "incomplete", fingerprint: "old" };
  const runner = new CoordinatedTurnRunner(receipts, new MemoryThreadLock());
  let calls = 0;
  await assert.rejects(
    runner.run({ threadId: "thread", clientTurnId: "turn", fingerprint: "new" }, async () => ({ answer: ++calls })),
    TurnConflictError,
  );
  assert.equal(calls, 0);
});

test("fingerprints are stable across object key order", () => {
  const runner = new CoordinatedTurnRunner(new MemoryReceipts(), new MemoryThreadLock());
  const left = runner.getFingerprint({
    target: { kind: "week", folder: "W1" },
    message: "same",
  });
  const right = runner.getFingerprint({
    message: "same",
    target: { folder: "W1", kind: "week" },
  });
  assert.equal(left, right);
});

class MemoryThreadLock implements ThreadLock {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(threadId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(
      threadId,
      previous.then(() => current),
    );
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

test("same turn and fingerprint replays without invoking again", async () => {
  const runner = new CoordinatedTurnRunner(new MemoryReceipts(), new MemoryThreadLock());
  let calls = 0;
  const request = {
    threadId: "thread",
    clientTurnId: "turn",
    fingerprint: "a",
  };
  const operation = async () => ({ answer: ++calls });
  assert.deepEqual(await runner.run(request, operation), { answer: 1 });
  assert.deepEqual(await runner.run(request, operation), { answer: 1 });
  assert.equal(calls, 1);
});

test("same turn with another fingerprint conflicts", async () => {
  const runner = new CoordinatedTurnRunner(new MemoryReceipts(), new MemoryThreadLock());
  await runner.run({ threadId: "thread", clientTurnId: "turn", fingerprint: "a" }, async () => ({ answer: 1 }));
  await assert.rejects(
    runner.run({ threadId: "thread", clientTurnId: "turn", fingerprint: "b" }, async () => ({ answer: 2 })),
    TurnConflictError,
  );
});

test("concurrent turns on one thread run serially", async () => {
  const runner = new CoordinatedTurnRunner(new MemoryReceipts(), new MemoryThreadLock());
  let active = 0;
  let maxActive = 0;
  const invoke = (turn: string) =>
    runner.run({ threadId: "thread", clientTurnId: turn, fingerprint: turn }, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { turn };
    });
  await Promise.all([invoke("one"), invoke("two")]);
  assert.equal(maxActive, 1);
});
