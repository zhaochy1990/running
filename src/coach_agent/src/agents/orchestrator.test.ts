import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import type { ModelConfig } from "../config/config.js";
import { getOrchestratorNode } from "./orchestrator.js";

/**
 * devops#832：分类模型抛错时 `intent decode failed` 的 `error` 字段必须带出
 * 真实 message/type/stack。10-29 生产簇状连挂（60-83%）现场 error 只剩 `{}`，
 * DeepSeek 到底返回 429 / 空 content / 非法 JSON 无从考证——本测试钉住日志
 * 可见性：走真实的 buildChatModel→invoke 抛错路径（非 mock 模块），endpoint
 * 指向本地 400 server（400 在 langchain STATUS_NO_RETRY 名单里，立即抛错
 * 不退避，测试毫秒级完成）。
 */
test("orchestrator decode-failure warn carries the serialized error", async () => {
  process.env.STRIDE_TEST_ORCHESTRATOR_KEY = "test-key";
  const server = createServer((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "no such model" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const modelConfig: ModelConfig = {
    name: "orchestrator-error-visibility",
    model: "no-such-model",
    endpoint,
    api_key_env: "STRIDE_TEST_ORCHESTRATOR_KEY",
    api_kind: "chat-completions",
    max_tokens: 8,
    timeout_s: 10,
  };

  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout) as (...args: unknown[]) => boolean;
  process.stdout.write = ((chunk: Uint8Array | string, ...rest: unknown[]) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return originalWrite(chunk, ...rest);
  }) as typeof process.stdout.write;
  let result: unknown;
  try {
    const node = getOrchestratorNode(modelConfig);
    result = await node({ messages: [new HumanMessage("明天跑什么？")], intent: null } as never, {} as never);
    // The tee is a plain Writable: give the log line a tick to land (assertions
    // read the captured chunks after stdout is restored).
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.stdout.write = originalWrite as unknown as typeof process.stdout.write;
    delete process.env.STRIDE_TEST_ORCHESTRATOR_KEY;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // 首轮 intent 为 null：decode 失败后兜底落 other，不炸图（既有语义不回归）。
  assert.ok(result instanceof Command);
  assert.deepEqual((result as { update: { intent: unknown } }).update.intent, { intent: "other" });

  // JSON 腿假设：stdout 非 TTY（node --test 子进程为管道）且默认 level=info ≥ warn。
  // 每条日志是单次 write 整行落盘；node:test 的控制流（test:enqueue 等二进制事件，
  // 不以换行结尾、会粘住后续数据）也走 stdout——按 chunk 分行后 JSON.parse 过滤即被丢弃，
  // 故不能先 join 全量再按子串找行。
  const decodeFailed = chunks
    .flatMap((chunk) => chunk.split("\n"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .find((entry) => entry.msg === "orchestrator: intent decode failed");
  assert.ok(decodeFailed, "expected the intent decode failed warn line on stdout (JSON leg needs piped stdout and level ≥ warn)");
  const error = decodeFailed.error as Record<string, unknown> | undefined;
  const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  assert.ok(nonEmptyString(error?.message), `error.message must be a non-empty string, not {}: ${JSON.stringify(error)}`);
  assert.ok(nonEmptyString(error?.type), `error.type must be a non-empty string: ${JSON.stringify(error)}`);
  assert.ok(nonEmptyString(error?.stack), `error.stack must be a non-empty string: ${JSON.stringify(error)}`);
});
