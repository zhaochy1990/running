import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachFileLogging, getLogger } from "./logger.js";

/** Give the in-process pretty transform a moment to flush to the sync file. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200));

test("attachFileLogging tees pretty, redacted, uncolored lines to the file", async () => {
  const root = mkdtempSync(join(tmpdir(), "stride-common-logfile-"));
  const file = join(root, "nested", "coach-api.log");
  try {
    const logger = getLogger("test:file-logging");
    assert.equal(attachFileLogging(file, { env: {} }), true);
    logger.info({ token: "super-secret" }, "hello file");
    await settle();

    const content = readFileSync(file, "utf8");
    assert.match(content, /hello file/);
    assert.match(content, /test:file-logging/);
    assert.match(content, /\[redacted\]/);
    assert.ok(!content.includes("super-secret"));
    assert.ok(!content.includes("["));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attachFileLogging is local-only and idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "stride-common-logfile-guard-"));
  const file = join(root, "coach-api.log");
  try {
    assert.equal(attachFileLogging(file, { env: { STRIDE_COACH_ENV: "prod" } }), false);
    assert.equal(existsSync(file), false);

    assert.equal(attachFileLogging(file, { env: {} }), true);
    assert.equal(attachFileLogging(join(root, "other.log"), { env: {} }), true);
    assert.equal(existsSync(join(root, "other.log")), false);
    assert.equal(attachFileLogging("", { env: {} }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
