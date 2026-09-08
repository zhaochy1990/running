import assert from "node:assert/strict";
import test from "node:test";
import { decodeMessage, encodeMessage } from "../../src/queue/codec.js";

test("pointer message round-trips through the wire format", () => {
  const buffer = encodeMessage({ jobId: "job-1", userId: "user-1" });
  assert.deepEqual(JSON.parse(buffer.toString("utf8")), { job_id: "job-1", user_id: "user-1" });
  assert.deepEqual(decodeMessage(buffer), { jobId: "job-1", userId: "user-1" });
});

test("undecodable bodies are rejected", () => {
  assert.throws(() => decodeMessage(Buffer.from("not json")), /malformed/);
  assert.throws(() => decodeMessage(Buffer.from("{}")), /job_id/);
  assert.throws(() => decodeMessage(Buffer.from('{"job_id":""}')), /job_id/);
});
