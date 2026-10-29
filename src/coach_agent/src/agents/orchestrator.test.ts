import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import type { ModelConfig } from "../config/config.js";
import { getOrchestratorNode } from "./orchestrator.js";

/**
 * 本地 chat-completions spy server：抓请求 body（bodies），回固定 intent 的合法
 * JSON completion。三个 wire 断言测试共用（#833 归一化 / #834 裁剪与孤儿 tool）。
 */
async function startCompletionSpy(cannedIntent: string) {
  process.env.STRIDE_TEST_ORCHESTRATOR_KEY = "test-key";
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Uint8Array) => {
      raw += Buffer.from(chunk).toString("utf8");
    });
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "deepseek-test",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ intent: cannedIntent }) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const modelConfig: ModelConfig = {
    name: "orchestrator-wire-test",
    model: "deepseek-test",
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    api_key_env: "STRIDE_TEST_ORCHESTRATOR_KEY",
    api_kind: "chat-completions",
    max_tokens: 64,
    timeout_s: 10,
  };
  return {
    bodies,
    modelConfig,
    close: async () => {
      delete process.env.STRIDE_TEST_ORCHESTRATOR_KEY;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

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

/**
 * devops#833：存量 checkpoint 里的数组 content 消息（responses API 落下）曾被
 * langchain 原样回传，DeepSeek 格式模仿破坏 json_object 约束（实测纯空白输出）。
 * 分类调用的 wire body 里全部消息 content 必须是字符串；归一化只影响本次调用，
 * state.messages 本身不得被改写。成功响应走通 parse → 污染历史上也能正常换意图。
 */
test("orchestrator sends string-only content on the wire for polluted history", async () => {
  const spy = await startCompletionSpy("custom_workout");

  const pollutedHistory = [
    new HumanMessage("帮我按照这个比赛策略生成单次训练课程"),
    new AIMessage({
      content: [
        { type: "text", text: "已生成比赛策略：" },
        { type: "text", text: "分段配速见卡片。" },
      ],
      // 取证会话的数组消息实测带 name（coach_messages.json）。
      name: "model",
      additional_kwargs: { card: { $type: "race-strategy" } },
    }),
    new AIMessage({ content: [] }),
    new AIMessage("还想再调一版策略。"),
  ];
  let result: unknown;
  try {
    const node = getOrchestratorNode(spy.modelConfig);
    result = await node({ messages: [...pollutedHistory], intent: { intent: "race_strategy" } } as never, {} as never);
  } finally {
    await spy.close();
  }

  assert.equal(spy.bodies.length, 1);
  const wireMessages = (spy.bodies[0] as { messages: { role: string; content: unknown }[] }).messages;
  // 浅会话（<N 条）全量保留：首条用户消息在 wire 上（「结合上文」类短回复样本
  // 轮次不足 N，靠完整上下文可判）；E5：分类 system 指令在末位。
  assert.equal(wireMessages.length, pollutedHistory.length + 1);
  for (const [index, message] of wireMessages.entries()) {
    assert.equal(typeof message.content, "string", `wire message ${index} content must be a string: ${JSON.stringify(message.content)}`);
  }
  assert.equal(wireMessages.at(-1)?.role, "system");
  assert.ok(String(wireMessages.at(-1)?.content).includes("classify their intent"));
  assert.equal(wireMessages[0]?.content, "帮我按照这个比赛策略生成单次训练课程");
  assert.equal(wireMessages[1]?.content, "已生成比赛策略：分段配速见卡片。");
  assert.equal(wireMessages[2]?.content, "");
  assert.equal(wireMessages[3]?.content, "还想再调一版策略。");

  // 读取侧 sanitize 只影响分类输入，不落 checkpoint：state 原数组保持数组形态。
  assert.ok(Array.isArray(pollutedHistory[1]?.content));
  assert.deepEqual(pollutedHistory[2]?.content, []);

  // 污染历史上分类照常成功并换掉旧意图（deep 会话 18/18 全挂的恢复路径）。
  assert.ok(result instanceof Command);
  assert.deepEqual((result as { update: { intent: unknown } }).update.intent, { intent: "custom_workout" });
});

/**
 * devops#834 E6+E5：分类输入裁剪到最近 N（=10）条 + 分类指令移末位（根因与
 * 取证见 orchestrator.ts 调用点注释）。wire body 必须恰好 N+1 条：最近 N 条
 * 历史（顺序保留、远处历史被裁掉）+ 末位 system。
 */
test("orchestrator trims classification input to the last N messages with the system prompt last", async () => {
  const spy = await startCompletionSpy("training_question");

  // 15 条深会话历史：内容带序号以便断言裁剪窗口取的是「最近 10 条」。
  const deepHistory = Array.from({ length: 15 }, (_, i) => (i % 2 === 0 ? new HumanMessage(`历史消息 ${i}`) : new AIMessage(`教练回复 ${i}`)));
  let result: unknown;
  try {
    const node = getOrchestratorNode(spy.modelConfig);
    result = await node({ messages: deepHistory, intent: { intent: "race_strategy" } } as never, {} as never);
  } finally {
    await spy.close();
  }

  assert.equal(spy.bodies.length, 1);
  const wireMessages = (spy.bodies[0] as { messages: { role: string; content: unknown }[] }).messages;
  // 恰好 N+1 条：最近 10 条（deepHistory[5..14]）+ 末位 system；消息 0-4 被裁掉。
  assert.equal(wireMessages.length, 11);
  assert.equal(wireMessages.at(-1)?.role, "system");
  assert.deepEqual(
    wireMessages.slice(0, 10).map((message) => message.content),
    deepHistory.slice(5).map((message) => String(message.content)),
  );

  // 裁剪只影响分类输入：state.messages 原样未被改写。
  assert.equal(deepHistory.length, 15);

  assert.ok(result instanceof Command);
  assert.deepEqual((result as { update: { intent: unknown } }).update.intent, { intent: "training_question" });
});

/**
 * devops#834 评审 P0：外层 state.messages 常态含内层 agent 的工具块
 * （AIMessage(tool_calls) + ToolMessage×k，取证会话实证）。裁剪边界切进工具块
 * （tool_calls 消息在窗外、其 ToolMessage 成为窗口首条）时，孤儿 tool 消息会
 * 被 DeepSeek 400 拒收，分类挂 fallback 锁旧意图——恰是本票要修的症状。
 * 窗口头部的孤儿 ToolMessage 必须被丢弃。
 */
test("orchestrator drops orphan tool messages cut by the trim boundary", async () => {
  const spy = await startCompletionSpy("weekly_plan");

  // 15 条历史，工具块在 4-6（AIM(tool_calls)@4 + TM@5,6）：slice(-10) 从 5 起，
  // 窗口头部恰为两个孤儿 ToolMessage（其 tool_calls 消息@4 在窗外）。
  const history = [
    new HumanMessage("历史消息 0"),
    new AIMessage("教练回复 1"),
    new HumanMessage("历史消息 2"),
    new AIMessage("教练回复 3"),
    new AIMessage({
      content: "我先查一下你最近的训练负荷。",
      tool_calls: [
        { id: "call_load", name: "get_daily_training_load", args: {} },
        { id: "call_hrv", name: "get_recovery_status", args: {} },
      ],
    }),
    new ToolMessage({ tool_call_id: "call_load", content: '{"load": 42}' }),
    new ToolMessage({ tool_call_id: "call_hrv", content: '{"hrv": 58}' }),
    new AIMessage("教练回复 7"),
    new HumanMessage("历史消息 8"),
    new AIMessage("教练回复 9"),
    new HumanMessage("历史消息 10"),
    new AIMessage("教练回复 11"),
    new HumanMessage("历史消息 12"),
    new AIMessage("教练回复 13"),
    new HumanMessage("历史消息 14"),
  ];
  let result: unknown;
  try {
    const node = getOrchestratorNode(spy.modelConfig);
    result = await node({ messages: history, intent: { intent: "race_strategy" } } as never, {} as never);
  } finally {
    await spy.close();
  }

  assert.equal(spy.bodies.length, 1);
  const wireMessages = (spy.bodies[0] as { messages: { role: string; content: unknown; tool_calls?: unknown }[] }).messages;
  // 孤儿 TM@5,6 被丢弃：wire 从消息 7 起（8 条历史 + 末位 system），无 role:tool。
  assert.equal(wireMessages.length, 9);
  assert.equal(wireMessages[0]?.content, "教练回复 7");
  for (const message of wireMessages) {
    assert.notEqual(message.role, "tool", "orphan tool messages must be dropped from the classification input");
  }
  assert.equal(wireMessages.at(-1)?.role, "system");

  // 丢孤儿后分类照常成功（不落 fallback 锁旧意图）。
  assert.ok(result instanceof Command);
  assert.deepEqual((result as { update: { intent: unknown } }).update.intent, { intent: "weekly_plan" });
});
