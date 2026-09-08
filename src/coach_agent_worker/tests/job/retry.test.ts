import assert from "node:assert/strict";
import test from "node:test";
import { decideFailure } from "../../src/job/retry.js";

test("poisons once attempts exhaust maxAttempts", () => {
  assert.deepEqual(decideFailure(2, 2, 10_000, 60_000), { outcome: "poison" });
  assert.deepEqual(decideFailure(3, 3, 10_000, 60_000), { outcome: "poison" });
});

test("retries with exponential backoff capped at maxBackoff", () => {
  assert.deepEqual(decideFailure(1, 2, 10_000, 60_000), { outcome: "retry", delayMs: 10_000 });
  assert.deepEqual(decideFailure(2, 3, 10_000, 60_000), { outcome: "retry", delayMs: 20_000 });
  // attempts=3: 2^(3-1)=4× base = 40s < 60s cap → still exponential.
  assert.deepEqual(decideFailure(3, 4, 10_000, 60_000), { outcome: "retry", delayMs: 40_000 });
  // grows past the cap → clamped.
  assert.deepEqual(decideFailure(4, 5, 10_000, 60_000), { outcome: "retry", delayMs: 60_000 });
});
