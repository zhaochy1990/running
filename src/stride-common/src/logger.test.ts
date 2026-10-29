import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachFileLogging, getLogger } from "./logger.js";

/** Give the in-process pretty transform a moment to flush to the sync file. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200));

// Attach is idempotent (keeps the first leg), so tests that must observe a
// fresh attach decision run before the first successful attach below.
test("attachFileLogging warns instead of throwing on an unopenable path", () => {
  const root = mkdtempSync(join(tmpdir(), "stride-common-logfile-eisdir-"));
  try {
    const target = join(root, "as-directory.log");
    mkdirSync(target);
    assert.equal(attachFileLogging(target, { env: {} }), false);
    getLogger("test:unopenable").info("stdout logging still works");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    assert.equal(attachFileLogging(file, { env: { NODE_ENV: "production" } }), false);

    assert.equal(attachFileLogging(file, { env: {} }), true);
    assert.equal(attachFileLogging(join(root, "other.log"), { env: {} }), true);
    assert.equal(existsSync(join(root, "other.log")), false);
    assert.equal(attachFileLogging("", { env: {} }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Capture what the root logger writes to stdout (JSON in tests: stdout is
 * piped, so the pretty leg is off) while still forwarding every chunk — the
 * test runner shares this stream, so swallowing writes would eat its output.
 */
async function captureStdoutLines(emit: () => void): Promise<Record<string, unknown>[]> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout) as (...args: unknown[]) => boolean;
  process.stdout.write = ((chunk: Uint8Array | string, ...rest: unknown[]) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return originalWrite(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    emit();
    // The tee is a plain Writable: the log line reaches it on a later tick.
    await settle();
  } finally {
    process.stdout.write = originalWrite as unknown as typeof process.stdout.write;
  }
  return chunks
    .flatMap((chunk) => chunk.split("\n"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

const findEntry = (entries: Record<string, unknown>[], msg: string): Record<string, unknown> => {
  const entry = entries.find((candidate) => candidate.msg === msg);
  assert.ok(entry, `expected a JSON log line with msg=${JSON.stringify(msg)}; captured: ${JSON.stringify(entries)}`);
  return entry;
};

/**
 * devops#832：Error 挂在 `error` 键下曾被 JSON.stringify 成 `{}`（pino 默认只
 * 序列化 `err` 键），生产 orchestrator intent decode failed 簇状连挂的真实原因
 * 无从考证。`error` 与 `err` 两个键都必须序列化出 type/message/stack。
 */
test("Error objects under the `error`/`err` keys serialize with type, message and stack", async () => {
  const entries = await captureStdoutLines(() => {
    getLogger("test:error-serializer").warn({ error: new Error("boom") }, "error key must survive");
    getLogger("test:error-serializer").warn({ err: new Error("kaboom") }, "err key must survive");
  });

  const errorEntry = findEntry(entries, "error key must survive");
  assert.equal((errorEntry.error as Record<string, unknown>).type, "Error");
  assert.equal((errorEntry.error as Record<string, unknown>).message, "boom");
  assert.match(String((errorEntry.error as Record<string, unknown>).stack), /boom/);

  const errEntry = findEntry(entries, "err key must survive");
  assert.equal((errEntry.err as Record<string, unknown>).message, "kaboom");
  assert.match(String((errEntry.err as Record<string, unknown>).stack), /kaboom/);
});

/**
 * devops#832：langchain 抛的 plain object（非 error-like）必须原样保留字段，不能更差。
 * 带描述性的 message-bearing 错误体（OpenAI 形状 `{type, message, code}`）尤其不能被
 * pino 默认 gate 误判成 error-like——那会把原生 `type` 换成 "Object" 并丢字段。
 */
test("plain-object `error` payloads keep their fields", async () => {
  const entries = await captureStdoutLines(() => {
    getLogger("test:error-serializer").warn({ error: { code: "E_PLAIN", detail: { depth: 1 } } }, "plain object payload");
    getLogger("test:error-serializer").warn({ error: { type: "insufficient_quota", message: "quota exceeded", code: 429 } }, "message-bearing error body");
  });

  const entry = findEntry(entries, "plain object payload");
  assert.equal((entry.error as Record<string, unknown>).code, "E_PLAIN");
  assert.deepEqual((entry.error as Record<string, unknown>).detail, { depth: 1 });

  const body = findEntry(entries, "message-bearing error body");
  assert.deepEqual(body.error, { type: "insufficient_quota", message: "quota exceeded", code: 429 });
});
