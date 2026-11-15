import assert from "node:assert/strict";
import test from "node:test";
import { generateProfile } from "./generate.js";

test("rejects every non-Flash model before making a model request", async () => {
  await assert.rejects(
    generateProfile(
      { userId: "one", startDay: "2026-05-20", endDay: "2026-11-15", capturedAt: "2026-11-15T12:00:00Z", coverage: {}, evidence: [] },
      {
        name: "pro",
        model: "deepseek-v4-pro",
        endpoint: "https://api.deepseek.com",
        api_key_env: "NONEXISTENT_TEST_KEY",
        api_kind: "responses",
        max_tokens: 32768,
        timeout_s: 300,
      },
      null,
      async () => {
        throw new Error("must not record or request");
      },
    ),
    /only use deepseek-flash/,
  );
});
